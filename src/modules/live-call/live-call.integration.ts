// Runs the ended-Call handler and the awaiting-Deal route against the compose Postgres
// (`bun run test:integration`): the real `live_call_waits` table with its row-level security, the
// Rep-origin insert that skips the rights check, and the wait cleared with the Call. Objects,
// vectors, the queue and voice stay in memory.

import { afterAll, describe, expect, test } from 'bun:test'
import { listAwaitingDealCallsResponseSchema } from 'tula-closeline-contract'
import { createDb, ORGANIZATIONS_WITH_WORK, type WorkDiscoveryRow } from 'tula-closeline-db'
import { type Discover, scopeOver, statementOf } from '~/adapters/postgres/processed-store'
import { integrationUrls } from '~/integration-support'
import { createCallHarness, wavBytes } from '~/modules/call/test-support'
import { ingestionHandlers } from '~/modules/ingestion/handlers'
import type { VoiceCallEnded } from './service'

const urls = integrationUrls()
const service = createDb(urls.service)
afterAll(async () => {
  await service.close()
})

const discover: Discover = (kind, after, batch) =>
  service.db.transaction(async (tx) => {
    const result = await tx.execute(statementOf(ORGANIZATIONS_WITH_WORK, [kind, after, batch]))
    return result.rows as unknown as WorkDiscoveryRow[]
  })

const hex = () => crypto.randomUUID().replaceAll('-', '')
const signal = new AbortController().signal

const ended = (callId: string, dealId: string | null): VoiceCallEnded =>
  ({
    callId,
    direction: 'inbound',
    lineId: `line_${hex()}`,
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
    dealId,
  }) as VoiceCallEnded

describe('an ended platform Call against Postgres', () => {
  test('waits without a Deal, is listed to its own Organization only, then becomes a Call with the wait cleared', async () => {
    // No rights confirmation is recorded: the Rep-origin insert must not need one.
    const h = await createCallHarness({ scope: scopeOver(service.db) })
    h.deps.discover = discover
    const other = await createCallHarness({ scope: scopeOver(service.db) })
    const callId = `call_${hex()}`
    h.deps.voiceRecordings.recordings.set(callId as never, wavBytes('pg'))
    const handlers = ingestionHandlers(h.deps, () => undefined)
    const deliver = (data: VoiceCallEnded) =>
      handlers['voice.call.ended']?.(
        { type: 'voice.call.ended', version: 1, payload: data } as never,
        { organizationId: h.organizationId, signal } as never
      )
    const listed = async (harness: typeof h) =>
      listAwaitingDealCallsResponseSchema
        .parse(await (await harness.send('GET', '/v1/playbook/calls/awaiting-deal')).json())
        .items.map((item) => item.callId)

    await deliver(ended(callId, null))
    await deliver(ended(callId, null))

    expect(await listed(h)).toEqual([callId as never])
    expect(await listed(other)).toEqual([])

    await deliver(ended(callId, 'DEAL-PG'))
    await deliver(ended(callId, 'DEAL-PG'))
    await h.runCalls()

    expect(await listed(h)).toEqual([])
    expect(await h.readCall(callId as never)).toMatchObject({ state: 'ready', inSearch: false })
    expect((await h.listAll()).map((c) => c.id)).toEqual([callId as never])
  })
})
