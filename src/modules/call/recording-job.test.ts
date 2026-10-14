import { describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { type Call, callSchema } from 'tula-closeline-contract'
import {
  CALL_JOB_FAIL,
  CALL_JOB_MAX_ATTEMPTS,
  CALL_JOB_RECORD,
  CALL_JOB_TRANSCRIBED,
  CALL_VENDOR_ID_RECORD,
} from 'tula-closeline-db'
import { logged } from '~/modules/ingestion/test-support'
import { CALLS, type CallHarness, channelRep, createCallHarness, wavBytes } from './test-support'

const SECRET_TEXT = 'the launch codes are swordfish-7731'

async function uploadRecording(
  h: CallHarness,
  seed: string,
  options: Parameters<CallHarness['uploadRecording']>[1] = {}
): Promise<Call> {
  const response = await h.uploadRecording(seed, options)
  expect(response.status).toBe(201)
  return callSchema.parse(await response.json())
}

const vectorsOf = (h: CallHarness, callId: string, org: string = h.organizationId) =>
  h.deps.vectors.search(org, {
    vector: new Array<number>(h.deps.vectors.dimensions).fill(0.1),
    topK: 100,
    filter: { call_id: callId },
  })

/** The turns of a done result: one speaker or channel per line. */
const turns = (labels: { speaker: string; channel?: number }[]) =>
  labels.map((label, index) => ({
    ...label,
    startMs: index * 5000,
    endMs: index * 5000 + 4000,
    text: `Said ${index} ${SECRET_TEXT}`,
  }))

const vendorSendsOf = (h: CallHarness) => h.deps.database.vendorSends(h.organizationId)

describe('transcribing a Recording', () => {
  test('a mono Recording is transcribed, kept, and waits in awaiting_rep until a Rep is picked', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'mono')

    await h.runCalls()

    const waiting = await h.readCall(call.id)
    expect(waiting).toMatchObject({
      state: 'awaiting_rep',
      speakerLabels: ['A', 'B'],
      durationSeconds: 20,
      rep: null,
      inSearch: false,
    })
    // No Moments exist until the Rep is known.
    expect(await vectorsOf(h, call.id)).toHaveLength(0)
    expect(await h.objectKeys()).toContain(`calls/${call.id}/transcript.json`)
    // One counted send, with the reference built from the Call id, and the vendor's id stored beside it.
    expect(vendorSendsOf(h)).toHaveLength(1)
    expect(vendorSendsOf(h)[0]).toMatchObject({ call_id: call.id, seq: 1 })
    expect(vendorSendsOf(h)[0]?.vendor_id).toMatch(/^mem_/)
    expect(h.deps.transcriber.copies(h.organizationId).map((c) => c.clientReference)).toEqual([
      `${call.id}:1`,
    ])

    const picked = await h.send('PUT', `${CALLS}/${call.id}/rep`, {
      body: { rep: { by: 'speaker', label: 'A' } },
    })
    expect(picked.status).toBe(200)
    await h.runCalls()
    const ready = await h.readCall(call.id)
    expect(ready).toMatchObject({ state: 'ready', rep: { by: 'speaker', label: 'A' } })
    expect((await vectorsOf(h, call.id)).length).toBeGreaterThan(0)
    // Picking did not transcribe again.
    expect(vendorSendsOf(h)).toHaveLength(1)
  })

  test('a per-side Recording assigns the Rep by channel and goes straight to ready', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'stereo', { rep: channelRep('left') })

    await h.runCalls()

    const ready = await h.readCall(call.id)
    expect(ready).toMatchObject({
      state: 'ready',
      speakerLabels: ['left', 'right'],
      rep: { by: 'channel', channel: 'left' },
    })
    expect((await vectorsOf(h, call.id)).length).toBeGreaterThan(0)
  })

  test('the presigned URL is signed just before the send, is short-lived, and is never logged', async () => {
    const h = await createCallHarness()
    const events: string[] = []
    const signed: string[] = []
    const realPresign = h.deps.objects.presignGet.bind(h.deps.objects)
    spyOn(h.deps.objects, 'presignGet').mockImplementation(async (org, key, options) => {
      events.push(`presign:${vendorSendsOf(h).length}`)
      const url = await realPresign(org, key, options)
      signed.push(url)
      return url
    })
    const realSubmit = h.deps.transcriber.submit.bind(h.deps.transcriber)
    let seen: { clientReference: string; audioKey: string; url: string } | undefined
    spyOn(h.deps.transcriber, 'submit').mockImplementation(async (org, request) => {
      events.push(`submit:${vendorSendsOf(h).length}`)
      seen = {
        clientReference: request.clientReference,
        audioKey: request.audioKey,
        url: request.audio.url,
      }
      return realSubmit(org, request)
    })
    const call = await uploadRecording(h, 'url')

    await h.runCalls()

    // The send was counted first, then the URL signed, then the request made.
    expect(events).toEqual(['presign:1', 'submit:1'])
    expect(seen?.clientReference).toBe(`${call.id}:1`)
    expect(seen?.audioKey).toContain(`calls/${call.id}/original.wav`)
    expect(seen?.url).toBe(signed[0] as string)
    const everything = [
      ...h.deps.logLines,
      ...h.deps.reported.map((r) => JSON.stringify(r.context)),
    ].join('\n')
    expect(everything).not.toContain('memory.object-store.invalid')
    expect(everything).not.toContain('sig=')
  })

  test('the expiry asked of the store is short', async () => {
    const h = await createCallHarness()
    const spy = spyOn(h.deps.objects, 'presignGet')
    await uploadRecording(h, 'expiry')
    await h.runCalls()
    const options = spy.mock.calls[0]?.[2]
    expect(options?.expiresInSeconds).toBeGreaterThan(0)
    expect(options?.expiresInSeconds).toBeLessThanOrEqual(300)
  })

  test('a result that is still pending gives the job back instead of holding it, and is read again later', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'slow')
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 2,
      result: {
        status: 'done',
        durationMs: 20_000,
        turns: turns([{ speaker: 'A' }, { speaker: 'B' }, { speaker: 'A' }, { speaker: 'B' }]),
      },
    })

    // The first claim submits, reads once, sees it pending and returns: nothing is left running.
    expect(await h.runCalls()).toBe(1)
    const job = h.deps.database.callJobs(h.organizationId).at(-1)
    expect(job?.state).toBe('queued')
    expect(job?.next_attempt_at).toBeGreaterThan(h.deps.clock.now().getTime())
    expect((await h.readCall(call.id)).state).toBe('transcribing')

    // Not due yet: nothing is claimed.
    expect(await h.runCalls()).toBe(0)
    await h.deps.time.advance(h.deps.env.TRANSCRIBE_POLL_INTERVAL_MS + 1000)
    await h.runCalls()
    await h.deps.time.advance(60_000)
    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('awaiting_rep')
    // Every look read the same send: one counted send, no second.
    expect(vendorSendsOf(h)).toHaveLength(1)
  })

  test('the looks thin out and a result that never arrives fails the Call with transcription_timed_out', async () => {
    const h = await createCallHarness({
      env: { TRANSCRIBE_POLL_INTERVAL_MS: '200', TRANSCRIBE_MAX_WAIT_MS: '10000' },
    })
    const call = await uploadRecording(h, 'never')
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 1000,
      result: { status: 'failed', reason: 'timed_out' },
    })

    let claims = 0
    for (let i = 0; i < 60 && (await h.readCall(call.id)).state !== 'failed'; i++) {
      claims += await h.runCalls()
      await h.deps.time.advance(500)
    }

    expect(await h.readCall(call.id)).toMatchObject({
      state: 'failed',
      failureReason: 'transcription_timed_out',
    })
    // Bounded: about a dozen looks for ten seconds, far fewer than one every poll interval.
    expect(claims).toBeLessThan(20)
    expect(vendorSendsOf(h)).toHaveLength(1)
  })

  test('a transient failure at a later look is retried, not given up at the ingestion attempt cap', async () => {
    const h = await createCallHarness({ env: { INGESTION_MAX_ATTEMPTS: '2' } })
    const call = await uploadRecording(h, 'later')
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 3,
      result: {
        status: 'done',
        durationMs: 20_000,
        turns: turns([{ speaker: 'A' }, { speaker: 'B' }]),
      },
    })
    await h.runCalls()
    await h.deps.time.advance(10_000)
    await h.runCalls()
    h.deps.transcriber.failNext('getResult', 'transcriber.unavailable')
    await h.deps.time.advance(20_000)
    await h.runCalls()
    expect((await h.readCall(call.id)).state).toBe('transcribing')
    for (let i = 0; i < 6; i++) {
      await h.deps.time.advance(60_000)
      await h.runCalls()
    }

    expect((await h.readCall(call.id)).state).toBe('awaiting_rep')
  })

  test.each([
    ['no_speech', 'no_turns'],
    ['audio_invalid', 'unreadable'],
    ['audio_unreachable', 'transcription_failed'],
    ['vendor_failed', 'transcription_failed'],
    ['timed_out', 'transcription_timed_out'],
    ['too_long', 'too_long'],
  ] as const)('a vendor failure of %s ends the Call failed with %s', async (vendor, reason) => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, vendor)
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 0,
      result: { status: 'failed', reason: vendor },
    })

    await h.runCalls()

    expect(await h.readCall(call.id)).toMatchObject({ state: 'failed', failureReason: reason })
  })

  test('a Recording longer than three hours is too_long, with no Transcript kept', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'long')
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 0,
      result: {
        status: 'done',
        durationMs: (3 * 60 * 60 + 1) * 1000,
        turns: turns([{ speaker: 'A' }, { speaker: 'B' }]),
      },
    })

    await h.runCalls()

    expect(await h.readCall(call.id)).toMatchObject({ state: 'failed', failureReason: 'too_long' })
    expect(await h.objectKeys()).not.toContain(`calls/${call.id}/transcript.json`)
  })

  test('a declared per-side Recording that has one channel speaking is not_per_side, keeps its speakers, and a different Rep fixes it', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'mono-as-stereo', { rep: channelRep('left') })
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 0,
      result: {
        status: 'done',
        durationMs: 20_000,
        turns: turns([
          { speaker: 'ch0', channel: 0 },
          { speaker: 'ch0', channel: 0 },
        ]),
      },
    })
    // The fallback send of the same file, separated by voice instead of by channel.
    h.deps.transcriber.script(h.organizationId, `${call.id}:2`, {
      pendingReads: 0,
      result: {
        status: 'done',
        durationMs: 20_000,
        turns: turns([{ speaker: 'A' }, { speaker: 'B' }, { speaker: 'A' }, { speaker: 'B' }]),
      },
    })

    await h.runCalls()

    // Failed, but the Transcript and the speakers a Rep can be picked from are kept.
    expect(await h.readCall(call.id)).toMatchObject({
      state: 'failed',
      failureReason: 'not_per_side',
      speakerLabels: ['A', 'B'],
    })
    expect(await h.objectKeys()).toContain(`calls/${call.id}/transcript.json`)
    expect(vendorSendsOf(h)).toHaveLength(2)

    const picked = await h.send('PUT', `/v1/playbook/calls/${call.id}/rep`, {
      body: { rep: { by: 'speaker', label: 'B' } },
    })
    expect(picked.status).toBe(200)
    await h.runCalls()

    expect(await h.readCall(call.id)).toMatchObject({
      state: 'ready',
      rep: { by: 'speaker', label: 'B' },
    })
    expect((await vectorsOf(h, call.id)).length).toBeGreaterThan(0)
    // Fixing it needed no third send.
    expect(vendorSendsOf(h)).toHaveLength(2)
  })

  test('a worker that dies after the fallback send finds that copy and ends the same way', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'fallback-crash', { rep: channelRep('right') })
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 0,
      result: {
        status: 'done',
        durationMs: 20_000,
        turns: turns([{ speaker: 'ch1', channel: 1 }]),
      },
    })
    h.deps.transcriber.script(h.organizationId, `${call.id}:2`, {
      pendingReads: 0,
      result: {
        status: 'done',
        durationMs: 20_000,
        turns: turns([{ speaker: 'A' }, { speaker: 'B' }]),
      },
    })
    // The record statement fails once after both sends: the retry reads the newest copy.
    h.deps.database.failNext(CALL_JOB_RECORD, new Error('connection lost'))

    await h.runCalls()
    await h.deps.time.advance(20 * 60 * 1000)
    await h.runCalls()

    expect(await h.readCall(call.id)).toMatchObject({
      state: 'failed',
      failureReason: 'not_per_side',
      speakerLabels: ['A', 'B'],
    })
    expect(vendorSendsOf(h)).toHaveLength(2)
  })

  test('a result with too few or too many speakers fails with the contract reason', async () => {
    const h = await createCallHarness()
    const one = await uploadRecording(h, 'one-speaker')
    h.deps.transcriber.script(h.organizationId, `${one.id}:1`, {
      pendingReads: 0,
      result: {
        status: 'done',
        durationMs: 20_000,
        turns: turns([{ speaker: 'A' }, { speaker: 'A' }]),
      },
    })
    await h.runCalls()
    expect((await h.readCall(one.id)).failureReason).toBe('too_few_speakers')
  })

  test('the 21st send is never made: the job fails and is not retried', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'bound')
    const row = h.deps.database.calls(h.organizationId).find((c) => c.id === call.id)
    Object.assign(row ?? {}, { vendor_send_seq: 20, sent_to_vendor_at: 1 })
    const submit = spyOn(h.deps.transcriber, 'submit')

    await h.runCalls()

    expect(submit).not.toHaveBeenCalled()
    expect(await h.readCall(call.id)).toMatchObject({
      state: 'failed',
      failureReason: 'transcription_failed',
    })
    expect(h.deps.database.callJobs(h.organizationId)[0]?.state).toBe('failed')
    expect(row?.vendor_send_seq).toBe(20)
  })

  test('a Call requeued after the vendor failed it makes a new counted send and goes on', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'requeue-failed', { dealId: 'D-1' })
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 0,
      result: { status: 'failed', reason: 'audio_unreachable' },
    })
    await h.runCalls()
    expect(await h.readCall(call.id)).toMatchObject({
      state: 'failed',
      failureReason: 'transcription_failed',
    })

    // Later, the same file again under the same Deal requeues the failed Call.
    await h.deps.time.advance(5_000)
    const again = await h.uploadRecording('requeue-failed', { dealId: 'D-1' })
    expect(again.status).toBe(200)
    await h.runCalls()

    expect(vendorSendsOf(h).map((send) => send.seq)).toEqual([1, 2])
    expect((await h.readCall(call.id)).state).toBe('awaiting_rep')
  })

  test('while polling, a vendor that fails the current send ends the Call transcription_failed after exactly one send', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'fails-while-polling', { dealId: 'D-1' })
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 1,
      result: { status: 'failed', reason: 'audio_invalid' },
    })

    await h.runCalls()
    expect((await h.readCall(call.id)).state).toBe('transcribing')
    await h.deps.time.advance(h.deps.env.TRANSCRIBE_POLL_INTERVAL_MS + 1000)
    await h.runCalls()
    await h.deps.time.advance(120_000)
    await h.runCalls()

    expect(await h.readCall(call.id)).toMatchObject({ state: 'failed' })
    expect(vendorSendsOf(h)).toHaveLength(1)
    expect(h.deps.transcriber.copies(h.organizationId)).toHaveLength(1)
  })

  test('a requeue after the vendor failed the send makes exactly one new send', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'requeue-once', { dealId: 'D-1' })
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 1,
      result: { status: 'failed', reason: 'audio_unreachable' },
    })
    await h.runCalls()
    await h.deps.time.advance(h.deps.env.TRANSCRIBE_POLL_INTERVAL_MS + 1000)
    await h.runCalls()
    expect(await h.readCall(call.id)).toMatchObject({
      state: 'failed',
      failureReason: 'transcription_failed',
    })
    expect(vendorSendsOf(h)).toHaveLength(1)

    await h.deps.time.advance(5_000)
    expect((await h.uploadRecording('requeue-once', { dealId: 'D-1' })).status).toBe(200)
    await h.runCalls()
    await h.deps.time.advance(120_000)
    await h.runCalls()

    expect(vendorSendsOf(h).map((send) => send.seq)).toEqual([1, 2])
    expect((await h.readCall(call.id)).state).toBe('awaiting_rep')
  })

  test('a send is keyed by the audio content hash: changed audio of the same size is a conflict', async () => {
    const h = await createCallHarness()
    const submit = spyOn(h.deps.transcriber, 'submit')
    const call = await uploadRecording(h, 'keyed')
    await h.runCalls()
    const sent = submit.mock.calls[0]?.[1]
    const sha = createHash('sha256').update(wavBytes('keyed')).digest('hex')
    expect(sent?.audioKey).toBe(`calls/${call.id}/original.wav:${sha}`)

    // The same reference again with other bytes of the same size does not pass for the same audio.
    const other = createHash('sha256').update(wavBytes('changed')).digest('hex')
    await expect(
      h.deps.transcriber.submit(h.organizationId, {
        ...(sent as NonNullable<typeof sent>),
        audioKey: `calls/${call.id}/original.wav:${other}`,
      })
    ).rejects.toMatchObject({ code: 'transcriber.conflict' })
  })

  test('a crash after a failed fallback send stays bounded by the 20 sends', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'fallback-loop', { rep: channelRep('left') })
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 0,
      result: {
        status: 'done',
        durationMs: 20_000,
        turns: turns([{ speaker: 'ch0', channel: 0 }]),
      },
    })
    for (let seq = 2; seq <= 25; seq++) {
      h.deps.transcriber.script(h.organizationId, `${call.id}:${seq}`, {
        pendingReads: 0,
        result: { status: 'failed', reason: 'vendor_failed' },
      })
    }
    // The database cannot be told how the job ended, again and again.
    for (let i = 0; i < 30; i++) {
      h.deps.database.failNext(CALL_JOB_FAIL, new Error('connection lost'))
    }

    for (let i = 0; i < 30; i++) {
      await h.runCalls()
      await h.deps.time.advance(20 * 60 * 1000)
    }

    expect(vendorSendsOf(h).length).toBeLessThanOrEqual(20)
    expect(h.deps.transcriber.copies(h.organizationId).length).toBeLessThanOrEqual(20)
  })

  test('the last claim fails a Call that is still pending as transcription_timed_out, whatever time remains', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'last-claim')
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 1000,
      result: { status: 'failed', reason: 'timed_out' },
    })
    await h.runCalls()
    // One claim short of the cap, with the wait far from over (the clocks may disagree).
    const job = h.deps.database.callJobs(h.organizationId).at(-1)
    Object.assign(job ?? {}, { attempts: CALL_JOB_MAX_ATTEMPTS - 2, next_attempt_at: 0 })

    await h.runCalls()

    expect(await h.readCall(call.id)).toMatchObject({
      state: 'failed',
      failureReason: 'transcription_timed_out',
    })
  })

  test('a vendor outage is retried with a new counted send; a refusal for good is not', async () => {
    const h = await createCallHarness()
    const outage = await uploadRecording(h, 'outage')
    h.deps.transcriber.failNext('submit', 'transcriber.unavailable')

    await h.runCalls()
    expect((await h.readCall(outage.id)).state).toBe('transcribing')
    await h.deps.time.advance(20 * 60 * 1000)
    await h.runCalls()

    expect((await h.readCall(outage.id)).state).toBe('awaiting_rep')
    expect(vendorSendsOf(h).map((send) => send.seq)).toEqual([1, 2])
    expect(h.deps.transcriber.copies(h.organizationId).map((c) => c.clientReference)).toEqual([
      `${outage.id}:2`,
    ])

    const refused = await uploadRecording(h, 'refused')
    h.deps.transcriber.failNext('submit', 'transcriber.rejected')
    await h.runCalls()
    expect(await h.readCall(refused.id)).toMatchObject({
      state: 'failed',
      failureReason: 'transcription_failed',
    })
  })

  test('a worker that died after the vendor accepted a send finds that copy again and sends nothing new', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'crash')
    h.deps.transcriber.acceptThenFailNext()

    await h.runCalls()
    // The vendor holds the audio and the service never learned its id.
    expect(vendorSendsOf(h)[0]?.vendor_id).toBeNull()
    expect(h.deps.transcriber.copies(h.organizationId)).toHaveLength(1)
    await h.deps.time.advance(20 * 60 * 1000)
    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('awaiting_rep')
    expect(vendorSendsOf(h).map((send) => send.seq)).toEqual([1])
    expect(vendorSendsOf(h)[0]?.vendor_id).toMatch(/^mem_/)
    expect(h.deps.transcriber.copies(h.organizationId)).toHaveLength(1)
  })

  test('a crash after the Transcript is kept and before the Call moves on only finishes the move', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'finish')
    h.deps.database.failNext(CALL_JOB_TRANSCRIBED, new Error('connection lost'))

    await h.runCalls()
    expect((await h.readCall(call.id)).state).toBe('transcribing')
    await h.deps.time.advance(20 * 60 * 1000)
    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('awaiting_rep')
    expect(vendorSendsOf(h)).toHaveLength(1)
    expect(h.deps.transcriber.copies(h.organizationId)).toHaveLength(1)
  })

  test('a vendor id the database calls a conflict (23505) is not fatal, is not logged, and the reference is used', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'conflict')
    h.deps.database.failNext(
      CALL_VENDOR_ID_RECORD,
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        detail: 'Key (organization_id, vendor_id)=(org, mem_secretvendorid) already exists.',
      })
    )

    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('awaiting_rep')
    expect(
      logged(h.deps, 'the vendor id of a send could not be recorded; the reference is used instead')
    ).toHaveLength(1)
    const everything = [
      ...h.deps.logLines,
      ...h.deps.reported.map((r) => JSON.stringify(r.context)),
    ].join('\n')
    expect(everything).not.toContain('mem_secretvendorid')
    expect(everything).not.toContain('mem_')
  })

  test('logs and reports hold no audio, Transcript text, label, file name, vendor id or URL', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'secrets', {
      name: 'Zebediah-Quillfeather.wav',
      dealId: 'ACME-SECRET-DEAL-9',
    })
    h.deps.transcriber.script(h.organizationId, `${call.id}:1`, {
      pendingReads: 0,
      result: {
        status: 'done',
        durationMs: 20_000,
        turns: turns([
          { speaker: 'Zebediah Quillfeather' },
          { speaker: 'Sam' },
          { speaker: 'Zebediah Quillfeather' },
          { speaker: 'Sam' },
        ]),
      },
    })
    h.deps.database.failNext(CALL_JOB_TRANSCRIBED, new Error(`broke on ${SECRET_TEXT}`))
    await h.runCalls()
    await h.deps.time.advance(20 * 60 * 1000)
    await h.runCalls()

    const everything = [
      ...h.deps.logLines,
      ...h.deps.reported.map((r) => JSON.stringify(r.context)),
    ].join('\n')
    for (const secret of [
      'Zebediah',
      'swordfish',
      'ACME-SECRET-DEAL-9',
      '.wav',
      'mem_',
      'memory.object-store',
    ]) {
      expect(everything).not.toContain(secret)
    }
    expect(logged(h.deps, 'a Call job ended').length).toBeGreaterThan(0)
  })

  test('a second Organization has its own sends and cannot touch these', async () => {
    const h = await createCallHarness()
    const call = await uploadRecording(h, 'a')
    await h.runCalls()
    const other = `org_${'5'.repeat(32)}`
    expect(h.deps.transcriber.copies(other)).toHaveLength(0)
    expect(h.deps.database.vendorSends(other)).toHaveLength(0)
    expect(await h.deps.transcriber.getResult(other, `${call.id}:1`)).toBeUndefined()
    expect(h.deps.transcriber.copies(h.organizationId)).toHaveLength(1)
  })

  test('the in-memory database refuses a vendor id twice for one send and one id on two sends', async () => {
    const h = await createCallHarness()
    const first = await uploadRecording(h, 'ids-1', { dealId: 'D-1' })
    const second = await uploadRecording(h, 'ids-2', { dealId: 'D-2' })
    await h.runCalls()
    const sends = vendorSendsOf(h)
    const firstId = sends.find((s) => s.call_id === first.id)?.vendor_id ?? ''
    const answer = (callId: string, id: string) =>
      h.deps.scope(h.organizationId, async (run) => {
        const rows = (await run(CALL_VENDOR_ID_RECORD, [h.organizationId, callId, 1, id])).rows
        return rows[0]?.result
      })

    expect(await answer(first.id, firstId)).toBe('unchanged')
    expect(await answer(first.id, 'other-id')).toBe('conflict')
    expect(await answer(second.id, firstId)).toBe('conflict')
    expect(await answer(second.id, 'bad id with spaces')).toBe('invalid')
  })
})
