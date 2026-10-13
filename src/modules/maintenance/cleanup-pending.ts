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

/** How far after `deleted_at` a document's `updated_at` may be and still read as untouched since the delete (microseconds of one statement; a second is generous). */
const UNTOUCHED_WITHIN_MS = 1_000

/**
 * Runs the vector cleanup of the Organization's deleted documents whose message may have been lost
 * (the `cleanup_pending` sweep, called only for an Organization that discovery named for that
 * kind). The database has no statement that lists only the pending cleanups, so this reads the
 * deleted documents (newest first, at most {@link CLEANUP_SCAN_PAGES} pages of 100) and cleans
 * those deleted more than five minutes ago that still look pending. A recorded cleanup bumps
 * `updated_at`, so a document whose `updated_at` is later than its `deleted_at` is skipped as
 * already cleaned; the cleanup itself is idempotent, so a wrong guess costs one redundant call
 * and the purge runs the cleanup again as the backstop. The scan stops after the first page on
 * which nothing needed cleaning. A listing of pending cleanups in the db library replaces this.
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
    let needed = 0
    for (const row of rows) {
      if (signal.aborted) {
        return cleaned
      }
      const deletedAt = pgTime(row.deleted_at)
      if (deletedAt === undefined || deletedAt.getTime() > oldEnough) {
        continue
      }
      const updatedAt = pgTime(row.updated_at)
      if (
        updatedAt !== undefined &&
        updatedAt.getTime() - deletedAt.getTime() > UNTOUCHED_WITHIN_MS
      ) {
        continue
      }
      needed++
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
    if (needed === 0) {
      break
    }
    const last = rows.at(-1)
    if (rows.length < LIST_PAGE || last === undefined) {
      break
    }
    cursor = { t: String(last.created_at), i: String(last.id) }
  }
  return cleaned
}
