import { describe, expect, spyOn, test } from 'bun:test'
import {
  type Call,
  callSchema,
  MAX_RECORDING_BYTES,
  rightsRequiredDetailsSchema,
} from 'tula-closeline-contract'
import { StorageError } from 'tula-closeline-kit'
import { CALL_BODY_LIMIT } from '~/http/limits'
import { errorCode, personIn } from '~/modules/document/test-support'
import { logged } from '~/modules/ingestion/test-support'
import { CALLS, channelRep, createCallHarness, wavBytes } from './test-support'

const callOf = async (response: Response): Promise<Call> => callSchema.parse(await response.json())

describe('uploading a Recording', () => {
  test('streams the file to storage and queues its transcription', async () => {
    const h = await createCallHarness()
    const response = await h.uploadRecording('a', { rep: channelRep('left') })

    expect(response.status).toBe(201)
    const call = await callOf(response)
    expect(call).toMatchObject({
      kind: 'recording',
      state: 'uploaded',
      mediaType: 'audio/wav',
      sizeBytes: 4096,
      rep: { by: 'channel', channel: 'left' },
    })
    expect(await h.objectKeys()).toEqual([`calls/${call.id}/original.wav`])
    const jobs = h.deps.database.callJobs(h.organizationId)
    expect(jobs.map((job) => job.kind)).toEqual(['transcribe'])
    expect(jobs[0]?.state).toBe('queued')
  })

  test('a Recording with no Rep waits for one after transcription', async () => {
    const h = await createCallHarness()
    const call = await callOf(await h.uploadRecording('norep'))
    expect(call.rep).toBeNull()
  })

  test('Admin may upload; Manager and Rep may not, and nothing is stored for them', async () => {
    const h = await createCallHarness()
    expect((await h.uploadRecording('admin', { as: h.people.admin })).status).toBe(201)
    for (const role of ['manager', 'rep'] as const) {
      const refused = await h.uploadRecording(role, { as: h.people[role] })
      expect(refused.status).toBe(403)
      expect(await errorCode(refused)).toBe('auth.forbidden')
    }
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test('without a rights confirmation it is refused before any byte is stored', async () => {
    const h = await createCallHarness()
    const stranger = personIn(`org_${'7'.repeat(32)}`, 'owner')
    const put = spyOn(h.deps.objects, 'putStream')

    const response = await h.uploadRecording('norights', { as: stranger })

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string; details: unknown } }
    expect(body.error.code).toBe('rights.confirmation_required')
    expect(rightsRequiredDetailsSchema.parse(body.error.details).wordingVersion).toBeGreaterThan(0)
    expect(put).not.toHaveBeenCalled()
  })

  test('the deal id and Rep must come before the file; a part after it is refused and nothing is kept', async () => {
    const h = await createCallHarness()
    const auth = await h.bearer(h.people.owner)
    const fileFirst = new FormData()
    fileFirst.append('file', new File([wavBytes('late')], 'call.wav', { type: 'audio/wav' }))
    fileFirst.append('dealId', 'DEAL-1')
    const late = await h.app.request(CALLS, { method: 'POST', body: fileFirst, headers: auth })
    expect(late.status).toBe(400)
    expect(await errorCode(late)).toBe('request.invalid')

    const fileLast = new FormData()
    fileLast.append('dealId', 'DEAL-1')
    fileLast.append('file', new File([wavBytes('after')], 'call.wav', { type: 'audio/wav' }))
    fileLast.append('rep', channelRep('left'))
    const after = await h.app.request(CALLS, { method: 'POST', body: fileLast, headers: auth })
    expect(after.status).toBe(400)
    expect(await h.objectKeys()).toHaveLength(0)
    expect(h.deps.database.calls(h.organizationId)).toHaveLength(0)
  })

  test('a speaker Rep is call.rep_invalid and a file that is not its container is call.unsupported_type, with nothing stored', async () => {
    const h = await createCallHarness()
    const speaker = await h.uploadRecording('s', {
      rep: JSON.stringify({ by: 'speaker', label: 'A' }),
    })
    expect(speaker.status).toBe(422)
    expect(await errorCode(speaker)).toBe('call.rep_invalid')

    const fake = await h.uploadRecording('f', {
      bytes: new TextEncoder().encode('just some text, not audio at all'),
    })
    expect(fake.status).toBe(415)
    expect(await errorCode(fake)).toBe('call.unsupported_type')

    const wrongName = await h.uploadRecording('m', { name: 'call.mp3', bytes: wavBytes('m') })
    expect(await errorCode(wrongName)).toBe('call.unsupported_type')

    const empty = await h.uploadRecording('e', { bytes: new Uint8Array(0) })
    expect(await errorCode(empty)).toBe('request.invalid')

    expect(await h.objectKeys()).toHaveLength(0)
  })

  /** Uploads a Recording of `size` bytes as a stream of 8 MiB chunks, through a store that counts and drops what it reads. */
  async function streamRecording(size: number) {
    const h = await createCallHarness()
    // The real store holds only parts of the stream too: this is about the route and the service.
    let peak = 0
    let total = 0
    spyOn(h.deps.objects, 'putStream').mockImplementation(async (_org, _key, body, options) => {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        peak = Math.max(peak, chunk.byteLength)
        total += chunk.byteLength
        if (total > options.maxBytes) {
          throw new StorageError('storage.object_too_large', 'over the limit')
        }
      }
      return { size: total, sha256: 'a'.repeat(64) }
    })
    const del = spyOn(h.deps.objects, 'delete')
    const chunk = wavBytes('big', 8 * 1024 * 1024)
    const head = new TextEncoder().encode(
      '--B\r\nContent-Disposition: form-data; name="dealId"\r\n\r\nDEAL-1\r\n' +
        '--B\r\nContent-Disposition: form-data; name="file"; filename="big.wav"\r\nContent-Type: audio/wav\r\n\r\n'
    )
    let remaining = size
    let started = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!started) {
          started = true
          controller.enqueue(head)
        }
        if (remaining > 0) {
          const next = chunk.subarray(0, Math.min(remaining, chunk.byteLength))
          remaining -= next.byteLength
          controller.enqueue(next)
          return
        }
        controller.enqueue(new TextEncoder().encode('\r\n--B--\r\n'))
        controller.close()
      },
    })
    const response = await h.app.request(CALLS, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: {
        ...(await h.bearer(h.people.owner)),
        'content-type': 'multipart/form-data; boundary=B',
      },
    })
    return { h, response, peak: () => peak, total: () => total, del }
  }

  test('a file one byte over 500 MB is call.too_large, read in chunks, with no partial object or Call', async () => {
    const run = await streamRecording(MAX_RECORDING_BYTES + 1)

    expect(run.response.status).toBe(413)
    expect(await errorCode(run.response)).toBe('call.too_large')
    // The route passed the stream on in the sender's chunks, never the whole file at once.
    expect(run.peak()).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(run.del).toHaveBeenCalled()
    expect(run.h.deps.database.calls(run.h.organizationId)).toHaveLength(0)
  }, 60_000)

  test('a body that runs past the upload limit is cut off as request.too_large', async () => {
    const run = await streamRecording(MAX_RECORDING_BYTES + 16 * 1024 * 1024)

    expect(run.response.status).toBe(413)
    expect(await errorCode(run.response)).toBe('request.too_large')
    expect(run.total()).toBeLessThanOrEqual(MAX_RECORDING_BYTES + 1)
    expect(run.h.deps.database.calls(run.h.organizationId)).toHaveLength(0)
  }, 60_000)

  test('a sender below the minimum rate is cut off as server.timeout, and the partial object is deleted', async () => {
    // 100,000 bytes a second over a 200 ms window; the sender manages about 400 a second.
    const h = await createCallHarness({
      env: { RECORDING_MIN_BYTES_PER_SECOND: '100000', RECORDING_RATE_WINDOW_MS: '200' },
    })
    const del = spyOn(h.deps.objects, 'delete')
    const head = new TextEncoder().encode(
      '--B\r\nContent-Disposition: form-data; name="dealId"\r\n\r\nDEAL-1\r\n' +
        '--B\r\nContent-Disposition: form-data; name="file"; filename="slow.wav"\r\nContent-Type: audio/wav\r\n\r\n'
    )
    const audio = wavBytes('slow')
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent === 0) {
          controller.enqueue(head)
          controller.enqueue(audio.subarray(0, 64))
          sent = 64
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
        controller.enqueue(audio.subarray(sent, sent + 20))
        sent += 20
      },
    })

    const response = await h.app.request(CALLS, {
      method: 'POST',
      body,
      duplex: 'half',
      headers: {
        ...(await h.bearer(h.people.owner)),
        'content-type': 'multipart/form-data; boundary=B',
      },
    })

    expect(response.status).toBe(504)
    expect(await errorCode(response)).toBe('server.timeout')
    expect(await h.objectKeys()).toHaveLength(0)
    expect(del).toHaveBeenCalled()
    expect(h.deps.database.calls(h.organizationId)).toHaveLength(0)
  }, 10_000)

  test('a sender at the minimum rate is not cut off', async () => {
    const h = await createCallHarness({
      env: { RECORDING_MIN_BYTES_PER_SECOND: '1000', RECORDING_RATE_WINDOW_MS: '200' },
    })
    const response = await h.uploadRecording('fast-enough')
    expect(response.status).toBe(201)
  })

  test('a body that declares more than the Call upload limit is request.too_large before it is read', async () => {
    const h = await createCallHarness()
    const response = await h.uploadRecording('declared', {})
    expect(response.status).toBe(201)
    const form = new FormData()
    form.append('dealId', 'DEAL-9')
    const refused = await h.app.request(CALLS, {
      method: 'POST',
      body: form,
      headers: {
        ...(await h.bearer(h.people.owner)),
        'content-length': String(CALL_BODY_LIMIT + 1),
      },
    })
    expect(refused.status).toBe(413)
    expect(await errorCode(refused)).toBe('request.too_large')
  })

  test('the same file under the same Deal is the same Call and keeps one object; another Deal is refused', async () => {
    const h = await createCallHarness()
    const first = await callOf(await h.uploadRecording('dup', { dealId: 'D-1' }))
    const again = await h.uploadRecording('dup', { dealId: 'D-1' })
    expect(again.status).toBe(200)
    expect((await callOf(again)).id).toBe(first.id)
    const other = await h.uploadRecording('dup', { dealId: 'D-2' })
    expect(other.status).toBe(409)
    expect(await errorCode(other)).toBe('call.content_in_other_deal')
    expect(await h.objectKeys()).toEqual([`calls/${first.id}/original.wav`])
    expect(h.deps.database.callJobs(h.organizationId)).toHaveLength(1)
  })

  test('an idempotency key replays the first answer and leaves one object', async () => {
    const h = await createCallHarness()
    const key = '0b9d3b5e-6f0e-4c63-9a53-5a7a1d9d2222'
    const first = await h.uploadRecording('key', { key })
    const replay = await h.uploadRecording('key', { key })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(await first.json())
    expect(await h.objectKeys()).toHaveLength(1)
    const other = await h.uploadRecording('key-other', { key })
    expect(other.status).toBe(422)
    expect(await errorCode(other)).toBe('request.idempotency_key_reused')
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test("another Organization cannot read the Recording's Call, and its quota is its own", async () => {
    const h = await createCallHarness()
    const call = await callOf(await h.uploadRecording('iso'))
    const stranger = personIn(`org_${'6'.repeat(32)}`, 'owner')
    h.confirmRights(stranger.organizationId)
    const read = await h.send('GET', `${CALLS}/${call.id}`, { as: stranger })
    expect(read.status).toBe(404)
    // The same bytes in the other Organization are a new Call there, not a duplicate of this one.
    const theirs = await h.uploadRecording('iso', { as: stranger })
    expect(theirs.status).toBe(201)
    expect((await callOf(theirs)).id).not.toBe(call.id)
    expect(await h.objectKeys(stranger.organizationId)).toHaveLength(1)
  })

  test('logs hold no file name, deal id or byte of the audio', async () => {
    const h = await createCallHarness()
    const response = await h.uploadRecording('log', {
      name: 'Quarterly-Zebediah-call.wav',
      dealId: 'ACME-SECRET-DEAL-5',
    })
    expect(response.status).toBe(201)
    const everything = [
      ...h.deps.logLines,
      ...h.deps.reported.map((r) => JSON.stringify(r.context)),
    ].join('\n')
    for (const secret of ['Zebediah', 'ACME-SECRET-DEAL-5']) {
      expect(everything).not.toContain(secret)
    }
    expect(logged(h.deps, 'a Call upload failed with an unknown outcome')).toHaveLength(0)
  })
})
