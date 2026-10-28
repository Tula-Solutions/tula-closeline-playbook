import {
  type AwaitingDealCall,
  callCursorSchema,
  decodeCursor,
  encodeCursor,
  type ListAwaitingDealCallsQuery,
  type listAwaitingDealCallsResponseSchema,
  PLAYBOOK_WRITE_ROLES,
} from 'tula-closeline-contract'
import { CALL_GET, LIVE_CALL_WAIT_LIST, LIVE_CALL_WAIT_RECORD } from 'tula-closeline-db'
import type { z } from 'zod'
import type { Container } from '~/container'
import type { PlaybookEnvelope } from '~/messages'
import { type CallDeps, ingestPlatformRecording } from '~/modules/call/service'
import { cursorPosition, optionalTimestamp } from '~/modules/deal/schema'
import {
  assertRole,
  type CallContext,
  failure,
  mappingBadCursor,
  transaction,
} from '~/modules/service-kit'

/** What the live-Call service needs from the container. */
export type LiveCallDeps = CallDeps & Pick<Container, 'voiceRecordings'>

/** The data of a `voice.call.ended` message. */
export type VoiceCallEnded = Extract<PlaybookEnvelope, { type: 'voice.call.ended' }>['payload']

/** What a `voice.call.ended` message came to. */
export type EndedCallResult = 'skipped' | 'waiting' | 'ingested' | 'existing' | 'no_recording'

/**
 * Handles one ended platform Call (spec M12). A Call that did not complete or has no Recording is
 * skipped. One with no Deal identifier from wrap-up waits in `live_call_waits` (the named state
 * `awaiting_deal`), unless it was ingested already; a later message for the same Call id that
 * carries the Deal ingests it and ends the wait. Otherwise the Recording is fetched from voice and
 * becomes a Call of that Deal (idempotent on the Call id). It is held out of search until the Deal
 * is won by the existing eligibility rule. Nothing here logs a Recording or its text.
 */
export async function handleEndedCall(
  deps: LiveCallDeps,
  organizationId: string,
  ended: VoiceCallEnded,
  signal: AbortSignal
): Promise<EndedCallResult> {
  if (ended.outcome !== 'completed' || ended.recordingKey === null) {
    return 'skipped'
  }
  if (ended.dealId === null) {
    return transaction(deps, organizationId, async (run) => {
      if ((await run(CALL_GET, [organizationId, ended.callId])).rows[0] !== undefined) {
        return 'existing'
      }
      await run(LIVE_CALL_WAIT_RECORD, [
        organizationId,
        ended.callId,
        ended.direction,
        ended.endedAt,
      ])
      return 'waiting'
    })
  }
  return ingestPlatformRecording(deps, {
    // The queue context carries the verified envelope's Organization as a plain string.
    organizationId: organizationId as CallContext['organizationId'],
    callId: ended.callId,
    dealId: ended.dealId,
    open: () => deps.voiceRecordings.open(organizationId, ended.callId, { signal }),
    signal,
  })
}

/** One page of the Calls waiting for a Deal, oldest first. Owner and Admin only. */
export async function listAwaitingDeal(
  deps: Pick<Container, 'scope'>,
  context: CallContext,
  query: ListAwaitingDealCallsQuery
): Promise<z.infer<typeof listAwaitingDealCallsResponseSchema>> {
  assertRole(context, PLAYBOOK_WRITE_ROLES)
  let after: { createdAt: string; id: string } | undefined
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, callCursorSchema)
    if (after === undefined) {
      throw failure('request.invalid')
    }
  }
  const { organizationId } = context
  const { limit } = query
  const rows = await mappingBadCursor(() =>
    transaction(
      deps,
      organizationId,
      async (run) =>
        (
          await run(LIVE_CALL_WAIT_LIST, [
            organizationId,
            after?.createdAt ?? '-infinity',
            after?.id ?? '',
            limit,
          ])
        ).rows
    )
  )
  const last = rows.at(-1)
  const items: AwaitingDealCall[] = rows.map((row) => ({
    callId: String(row.call_id) as AwaitingDealCall['callId'],
    direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
    endedAt: optionalTimestamp.parse(row.ended_at) as string,
    createdAt: optionalTimestamp.parse(row.created_at) as string,
  }))
  return {
    items,
    nextCursor:
      rows.length === limit && last !== undefined
        ? encodeCursor(cursorPosition({ cursor_at: last.cursor_at, id: last.call_id }))
        : null,
  }
}
