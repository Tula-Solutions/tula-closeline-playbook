import { describe, expect, test } from 'bun:test'
import { listAwaitingDealCallsResponseSchema } from 'tula-closeline-contract'
import { CALLS, type CallHarness, createCallHarness, wavBytes } from '~/modules/call/test-support'
import { ingestionHandlers } from '~/modules/ingestion/handlers'
import type { VoiceCallEnded } from './service'

const signal = new AbortController().signal
const AWAITING = '/v1/playbook/calls/awaiting-deal'
const CALL_A = `call_${'a'.repeat(32)}` as VoiceCallEnded['callId']
const CALL_B = `call_${'b'.repeat(32)}` as VoiceCallEnded['callId']

const ended = (
  callId: VoiceCallEnded['callId'],
  patch: Partial<VoiceCallEnded> = {}
): VoiceCallEnded => ({
  callId,
  direction: 'outbound',
  lineId: `line_${'1'.repeat(32)}` as VoiceCallEnded['lineId'],
  repMembershipId: null,
  prospectId: null,
  prospectPhoneHash: '0'.repeat(64),
  outcome: 'completed',
  failureReason: null,
  startedAt: '2026-01-01T10:00:00.000Z',
  answeredAt: '2026-01-01T10:00:05.000Z',
  endedAt: '2026-01-01T10:05:00.000Z',
  durationSeconds: 295,
  disclosureWordingVersion: 1,
  recordingKey: 'rec/one',
  dealId: 'DEAL-1' as VoiceCallEnded['dealId'],
  ...patch,
})

/** Delivers a `voice.call.ended` message to the real handler, as the consumer would. */
async function deliver(h: CallHarness, data: VoiceCallEnded, organizationId = h.organizationId) {
  const handlers = ingestionHandlers(h.deps, () => undefined)
  await handlers['voice.call.ended']?.(
    { type: 'voice.call.ended', version: 1, payload: data } as never,
    { organizationId, signal } as never
  )
}

const vectorsOf = (h: CallHarness, callId: string, org: string = h.organizationId) =>
  h.deps.vectors.search(org, {
    vector: new Array<number>(h.deps.vectors.dimensions).fill(0.1),
    topK: 100,
    filter: { call_id: callId },
  })

const awaiting = async (h: CallHarness, as = h.people.owner) => h.send('GET', AWAITING, { as })

describe('an ended platform Call', () => {
  test('becomes a Call with Moments without a rights confirmation, absent from search until its Deal is won', async () => {
    const h = await createCallHarness()
    // Rights confirmed at a stale wording: an upload would be refused, a platform Call is not.
    h.deps.database.seedRights({
      organization_id: h.organizationId,
      confirmed_by: h.people.owner.userId,
      confirmed_at: 0,
      wording_version: 0,
    })
    h.deps.voiceRecordings.recordings.set(CALL_A, wavBytes('live'))

    await deliver(h, ended(CALL_A))
    await h.runCalls()

    const call = await h.readCall(CALL_A)
    expect(call).toMatchObject({ state: 'ready', inSearch: false, rep: { by: 'channel' } })
    expect(await h.moments(CALL_A)).toMatchObject({ returnable: 0, outcomes: ['open'] })
    expect((await vectorsOf(h, CALL_A)).length).toBeGreaterThan(0)

    await h.setOutcome(h.deps.database.deals(h.organizationId)[0]?.id ?? '', 'won')
    await h.deps.workers.ingestion.runPass()

    expect(await h.moments(CALL_A)).toMatchObject({ returnable: 2, outcomes: ['won'] })
    expect((await h.readCall(CALL_A)).inSearch).toBe(true)
  })

  test('is ingested once when the message is redelivered', async () => {
    const h = await createCallHarness()
    h.deps.voiceRecordings.recordings.set(CALL_A, wavBytes('live'))

    await deliver(h, ended(CALL_A))
    await deliver(h, ended(CALL_A))
    await h.runCalls()

    expect((await h.listAll()).map((c) => c.id)).toEqual([CALL_A])
    expect((await h.objectKeys()).filter((key) => key.endsWith('.wav'))).toHaveLength(1)
  })

  test('never appears for another Organization', async () => {
    const h = await createCallHarness()
    const other = `org_${'9'.repeat(32)}`
    h.deps.voiceRecordings.recordings.set(CALL_A, wavBytes('live'))

    await deliver(h, ended(CALL_A))
    await h.runCalls()

    expect(await vectorsOf(h, CALL_A, other)).toHaveLength(0)
    expect(h.deps.database.deals(other)).toHaveLength(0)
    await deliver(h, ended(CALL_B, { dealId: null }), other)
    const listed = listAwaitingDealCallsResponseSchema.parse(await (await awaiting(h)).json())
    expect(listed.items).toEqual([])
  })

  test('without a Deal waits, is listed for an Owner and an Admin only, and is ingested when the Deal arrives', async () => {
    const h = await createCallHarness()
    h.deps.voiceRecordings.recordings.set(CALL_A, wavBytes('live'))

    await deliver(h, ended(CALL_A, { dealId: null }))
    await deliver(h, ended(CALL_A, { dealId: null }))

    for (const person of [h.people.owner, h.people.admin]) {
      const response = await awaiting(h, person)
      expect(response.status).toBe(200)
      const listed = listAwaitingDealCallsResponseSchema.parse(await response.json())
      expect(listed.items.map((item) => item.callId)).toEqual([CALL_A])
    }
    expect((await awaiting(h, h.people.manager)).status).toBe(403)
    expect((await awaiting(h, h.people.rep)).status).toBe(403)
    expect((await h.send('GET', `${CALLS}/${CALL_A}`)).status).toBe(404)

    await deliver(h, ended(CALL_A))
    await h.runCalls()

    expect((await h.readCall(CALL_A)).state).toBe('ready')
    const after = listAwaitingDealCallsResponseSchema.parse(await (await awaiting(h)).json())
    expect(after.items).toEqual([])
  })

  test('pages the waiting list by cursor', async () => {
    const h = await createCallHarness()
    await deliver(h, ended(CALL_A, { dealId: null }))
    await deliver(h, ended(CALL_B, { dealId: null }))

    const first = listAwaitingDealCallsResponseSchema.parse(
      await (await h.send('GET', `${AWAITING}?limit=1`)).json()
    )
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()
    const second = listAwaitingDealCallsResponseSchema.parse(
      await (await h.send('GET', `${AWAITING}?limit=1&cursor=${first.nextCursor}`)).json()
    )
    expect([first.items[0]?.callId, second.items[0]?.callId].sort()).toEqual([CALL_A, CALL_B])
  })

  test('is skipped when it did not complete or has no Recording, and is left alone when voice has none', async () => {
    const h = await createCallHarness()

    await deliver(
      h,
      ended(CALL_A, {
        outcome: 'missed',
        durationSeconds: null,
        disclosureWordingVersion: null,
        recordingKey: null,
        dealId: null,
      })
    )
    await deliver(h, ended(CALL_A, { recordingKey: null }))
    await deliver(h, ended(CALL_B))
    await h.runCalls()

    expect(await h.listAll()).toEqual([])
    const listed = listAwaitingDealCallsResponseSchema.parse(await (await awaiting(h)).json())
    expect(listed.items).toEqual([])
  })

  test('logs neither the Recording nor its text', async () => {
    const h = await createCallHarness()
    h.deps.voiceRecordings.recordings.set(CALL_A, wavBytes('live'))

    await deliver(h, ended(CALL_A))
    await h.runCalls()

    const output = h.deps.logLines.join('\n')
    expect(output).not.toContain('Turn 1 of the scripted conversation')
    expect(output).not.toContain('rec/one')
  })
})
