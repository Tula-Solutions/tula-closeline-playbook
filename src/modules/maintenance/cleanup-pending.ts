import { DOCUMENT_LIST_FILTERED } from 'tula-closeline-db'
import { parsePgTimestamp } from '~/modules/document/schema'
import { cleanupDeletion } from '~/modules/ingestion/cleanup'
import {
  CLEANUP_PENDING_AFTER_MS,
  inTransaction,
  type PipelineDeps,
} from '~/modules/ingestion/runtime'

/** A timestamp column as a date, or `undefined` when the row has none. */
function pgTime(value: unknown): Date | undefined {
  return value instanceof Date
    ? value
    : typeof value === 'string'
      ? parsePgTimestamp(value)
      : undefined
}

/** The listing pages of deleted documents one Organization's cleanup pass reads. */
export const CLEANUP_SCAN_PAGES = 5

/** The documents on a listing page: the most the list statement returns. */
const LIST_PAGE = 100

/**
 * Runs the vector cleanup of the Organization's deleted documents whose message may have been lost
 * (the `cleanup_pending` sweep, called only for an Organization that discovery named for that
 * kind). The database has no statement that lists only the pending cleanups, so this reads the
 * deleted documents (newest first, at most {@link CLEANUP_SCAN_PAGES} pages of 100, always all
 * of them) and runs the cleanup on every one deleted more than five minutes ago. No row says
 * whether its cleanup is recorded, so none is skipped: the cleanup is idempotent, and a redundant
 * run costs a vector delete, while a skipped one would leave vectors behind.
 * TODO: replace with `DOCUMENT_LIST_PENDING_CLEANUP` when db v0.13.0 lands (hub issue 58).
 * Returns how many cleanups it completed.
 */
export async function cleanupPending(
  deps: PipelineDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<number> {
  let cursor = { t: 'infinity', i: '' }
  let cleaned = 0
  const oldEnough = deps.clock.now().getTime() - CLEANUP_PENDING_AFTER_MS
  for (let page = 0; page < CLEANUP_SCAN_PAGES && !signal.aborted; page++) {
    const rows = (
      await inTransaction(deps, organizationId, (run) =>
        run(DOCUMENT_LIST_FILTERED, [organizationId, cursor.t, cursor.i, LIST_PAGE, 'deleted'])
      )
    ).rows
    for (const row of rows) {
      if (signal.aborted) {
        return cleaned
      }
      const deletedAt = pgTime(row.deleted_at)
      if (deletedAt === undefined || deletedAt.getTime() > oldEnough) {
        continue
      }
      const result = await cleanupDeletion(
        deps,
        organizationId,
        String(row.id),
        Number(row.deletion_seq),
        signal
      )
      if (result === 'done') {
        cleaned++
      }
    }
    const last = rows.at(-1)
    if (rows.length < LIST_PAGE || last === undefined) {
      break
    }
    cursor = { t: String(last.created_at), i: String(last.id) }
  }
  return cleaned
}
