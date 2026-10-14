import {
  type Deal,
  decodeCursor,
  encodeCursor,
  type ListDealsQuery,
  type ListDealsResponse,
  type LookupDealRequest,
  SALES_HISTORY_READ_ROLES,
  type SetDealOutcomeRequest,
} from 'tula-closeline-contract'
import {
  DEAL_BY_DEAL_ID,
  DEAL_GET,
  DEAL_LIST,
  DEAL_LIST_BY_IMPORT_FLAG,
  DEAL_LIST_BY_OUTCOME,
  DEAL_SET_OUTCOME,
} from 'tula-closeline-db'
import { postgresErrorOf } from '~/adapters/postgres/retry'
import type { Container } from '~/container'
import { registry } from '~/messages'
import { assertRole, type CallContext, failure, transaction } from '~/modules/service-kit'
import { cursorOf, dealCursorSchema, outcomeSeqSchema, toDeal } from './schema'

/** What the Deal service needs from the container. */
export type DealDeps = Pick<Container, 'scope' | 'queue' | 'logger'>

/** The state of a bad list cursor in Postgres, which the service answers as a validation error. */
const INVALID_DATETIME = '22007'

/** Runs a read or write and maps an invalid-cursor answer from the database to `request.invalid`. */
async function mappingBadCursor<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (postgresErrorOf(error)?.code === INVALID_DATETIME) {
      throw failure('request.invalid')
    }
    throw error
  }
}

/**
 * One page of the Organization's Deals, newest first. The list statement follows the filter:
 * none, an Outcome, or whether the Deal ever appeared in an import. Both filters at once are
 * `request.invalid`, because no statement serves them together and filtering a page afterwards
 * would make short pages. The cursor is built from the statement's own `cursor_at` text.
 */
export async function list(
  deps: DealDeps,
  context: CallContext,
  query: ListDealsQuery
): Promise<ListDealsResponse> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  if (query.outcome !== undefined && query.appearedInImport !== undefined) {
    throw failure('request.invalid')
  }
  let after: { createdAt: string; id: string } | undefined
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, dealCursorSchema)
    if (after === undefined) {
      throw failure('request.invalid')
    }
  }
  const organizationId = context.organizationId
  const { limit } = query
  const position = [after?.createdAt ?? 'infinity', after?.id ?? ''] as const
  const rows = await mappingBadCursor(() =>
    transaction(deps, organizationId, async (run) => {
      if (query.outcome !== undefined) {
        return (
          await run(DEAL_LIST_BY_OUTCOME, [organizationId, ...position, limit, query.outcome])
        ).rows
      }
      if (query.appearedInImport !== undefined) {
        return (
          await run(DEAL_LIST_BY_IMPORT_FLAG, [
            organizationId,
            ...position,
            limit,
            query.appearedInImport,
          ])
        ).rows
      }
      return (await run(DEAL_LIST, [organizationId, ...position, limit])).rows
    })
  )
  const last = rows.at(-1)
  return {
    items: rows.map((row) => toDeal(row)),
    nextCursor: rows.length === limit && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  }
}

/** Reads one Deal by its record id, or `deal.not_found`. */
export async function get(
  deps: DealDeps,
  context: CallContext,
  dealRecordId: string
): Promise<Deal> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const organizationId = context.organizationId
  const row = await transaction(
    deps,
    organizationId,
    async (run) => (await run(DEAL_GET, [organizationId, dealRecordId])).rows[0]
  )
  if (row === undefined) {
    throw failure('deal.not_found')
  }
  return toDeal(row)
}

/** Finds a Deal by the customer's own deal id (sent in the body, never in a path), or `deal.not_found`. The id is never logged. */
export async function lookup(
  deps: DealDeps,
  context: CallContext,
  request: LookupDealRequest
): Promise<Deal> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const organizationId = context.organizationId
  const row = await transaction(
    deps,
    organizationId,
    async (run) => (await run(DEAL_BY_DEAL_ID, [organizationId, request.dealId])).rows[0]
  )
  if (row === undefined) {
    throw failure('deal.not_found')
  }
  return toDeal(row)
}

/**
 * Sets a Deal's Outcome (and its closing time when the request carries one, `null` clearing it).
 * The statement locks the row and moves `outcome_seq` by one only when something changed; a repeat
 * answers the Deal unchanged and publishes nothing. When the sequence moved, the Outcome-changed
 * message is published after the commit.
 *
 * If that publish fails the change stands and is logged (ids only). Nothing is lost: the Call
 * re-tag job of a later ticket compares each Call's stored sequence with the Deal's `outcome_seq`
 * in Postgres, so a sweep over Deals whose Calls carry an older sequence finds the missed one.
 */
export async function setOutcome(
  deps: DealDeps,
  context: CallContext,
  dealRecordId: string,
  request: SetDealOutcomeRequest
): Promise<Deal> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const organizationId = context.organizationId
  const closedAtGiven = request.closedAt !== undefined
  const row = await transaction(
    deps,
    organizationId,
    async (run) =>
      (
        await run(DEAL_SET_OUTCOME, [
          organizationId,
          dealRecordId,
          request.outcome,
          request.closedAt ?? null,
          closedAtGiven,
        ])
      ).rows[0]
  )
  if (row === undefined) {
    throw failure('deal.not_found')
  }
  if (row.changed === true) {
    await publishOutcomeChanged(
      deps,
      context,
      dealRecordId,
      outcomeSeqSchema.parse(row.outcome_seq)
    )
  }
  return toDeal(row)
}

/** Publishes the Outcome-changed message; a failure is logged with ids only and changes nothing the caller was told. */
export async function publishOutcomeChanged(
  deps: Pick<DealDeps, 'queue' | 'logger'>,
  context: Pick<CallContext, 'organizationId' | 'requestId'>,
  dealRecordId: string,
  outcomeSeq: number
): Promise<void> {
  try {
    await deps.queue.publish(
      registry.create({
        type: 'playbook.deal_outcome_changed',
        organizationId: context.organizationId,
        traceId: context.requestId,
        payload: { dealRecordId, outcomeSeq },
      })
    )
  } catch (error) {
    deps.logger.error(
      'a committed Outcome change could not be published; the re-tag job recovers from outcome_seq',
      {
        organizationId: context.organizationId,
        dealRecordId,
        outcomeSeq,
        error: error instanceof Error ? error.name : 'unknown',
      }
    )
  }
}
