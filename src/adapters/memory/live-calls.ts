import {
  DOCUMENT_LIST_MAX_PAGE,
  LIVE_CALL_WAIT_CLEAR,
  LIVE_CALL_WAIT_LIST,
  LIVE_CALL_WAIT_RECORD,
} from 'tula-closeline-db'
import type { Result } from '~/adapters/postgres/processed-store'

/** One row of `playbook.live_call_waits`. Times are milliseconds except `created_at_us`. */
export type MemoryLiveCallWaitRow = {
  organization_id: string
  call_id: string
  direction: string
  ended_at: number
  created_at_us: number
}

/** What the live-Call statements need from the double they run in. */
export type LiveCallStatementContext = {
  liveWaits: MemoryLiveCallWaitRow[]
  own(organization: unknown): boolean
  nextMicroseconds(): number
  rows(list: readonly unknown[]): Result
  none: Result
  batch(value: unknown, max: number): number
  pgTimestamp(ms: number): string
  pgTimestampUs(us: number): string
  cursorMicroseconds(text: unknown): number
}

/** Runs one live-Call wait statement of the db library against the double, or returns `undefined` for any other. */
export function runLiveCallStatement(
  text: string,
  params: readonly unknown[],
  ctx: LiveCallStatementContext
): Result | undefined {
  const [organization, callId] = params as [string, string]
  const mine = ctx.liveWaits.filter(
    (w) => ctx.own(organization) && w.organization_id === organization
  )
  switch (text) {
    case LIVE_CALL_WAIT_RECORD: {
      if (!ctx.own(organization) || mine.some((w) => w.call_id === callId)) {
        return ctx.none
      }
      ctx.liveWaits.push({
        organization_id: organization,
        call_id: callId,
        direction: String(params[2]),
        ended_at: new Date(String(params[3])).getTime(),
        created_at_us: ctx.nextMicroseconds(),
      })
      return ctx.rows([{ call_id: callId }])
    }
    case LIVE_CALL_WAIT_CLEAR: {
      const at = ctx.liveWaits.findIndex(
        (w) => ctx.own(organization) && w.organization_id === organization && w.call_id === callId
      )
      if (at < 0) {
        return ctx.none
      }
      ctx.liveWaits.splice(at, 1)
      return ctx.rows([{ call_id: callId }])
    }
    case LIVE_CALL_WAIT_LIST: {
      const [, createdAfter, idAfter, size] = params as [unknown, string, string, unknown]
      const after = createdAfter === '-infinity' ? -1 : ctx.cursorMicroseconds(createdAfter)
      return ctx.rows(
        mine
          .filter(
            (w) =>
              w.created_at_us > after || (w.created_at_us === after && w.call_id > String(idAfter))
          )
          .sort((a, b) => a.created_at_us - b.created_at_us || (a.call_id < b.call_id ? -1 : 1))
          .slice(0, ctx.batch(size, DOCUMENT_LIST_MAX_PAGE))
          .map((w) => ({
            call_id: w.call_id,
            direction: w.direction,
            ended_at: ctx.pgTimestamp(w.ended_at),
            created_at: ctx.pgTimestampUs(w.created_at_us),
            cursor_at: ctx.pgTimestampUs(w.created_at_us),
          }))
      )
    }
    default:
      return undefined
  }
}
