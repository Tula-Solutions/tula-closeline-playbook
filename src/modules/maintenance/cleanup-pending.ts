import { DOCUMENT_LIST_FILTERED } from 'tula-closeline-db'
import { parsePgTimestamp } from '~/modules/document/schema'
import { cleanupDeletion } from '~/modules/ingestion/cleanup'
import {
  CLEANUP_PENDING_AFTER_MS,
  inTransaction,
  type PipelineDeps,
} from '~/modules/ingestion/runtime'

/** The listing pages of deleted documents one Organization's cleanup pass reads. */
export const CLEANUP_SCAN_PAGES = 5

/** The documents on a listing page: the most the list statement returns. */
const LIST_PAGE = 100

/**
 * Runs the vector cleanup of the Organization's deleted documents whose message may have been lost
 * (the `cleanup_pending` sweep). The database has no statement that lists only the deletions whose
 * cleanup is not recorded, so this reads the deleted documents (newest first, at most
 * {@link CLEANUP_SCAN_PAGES} pages of 100) and runs the same cleanup as the message handler on
 * each one that was deleted more than five minutes ago, which is a no-op for the deletions
 * already recorded as cleaned. Returns how many cleanups it completed.
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
      const deletedAt =
        row.deleted_at instanceof Date
          ? row.deleted_at
          : typeof row.deleted_at === 'string'
            ? parsePgTimestamp(row.deleted_at)
            : undefined
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
