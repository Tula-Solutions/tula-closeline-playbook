import { DOCUMENT_LIST_PENDING_CLEANUP } from 'tula-closeline-db'
import { parsePgTimestamp } from '~/modules/document/schema'
import { cleanupDeletion } from '~/modules/ingestion/cleanup'
import {
  CLEANUP_PENDING_AFTER_MS,
  inTransaction,
  type PipelineDeps,
  reportWorkerError,
} from '~/modules/ingestion/runtime'

/** A timestamp column as a date, or `undefined` when the row has none. */
function pgTime(value: unknown): Date | undefined {
  return value instanceof Date
    ? value
    : typeof value === 'string'
      ? parsePgTimestamp(value)
      : undefined
}

/** A timestamp column as the text a keyset cursor carries (the database's own text, or ISO for a date). */
function pgText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/** The listing pages of pending cleanups one Organization's pass reads. */
export const CLEANUP_SCAN_PAGES = 5

/** The documents on a listing page. */
const LIST_PAGE = 100

/**
 * Runs the vector cleanup of the Organization's deleted documents whose cleanup is not recorded
 * (the `cleanup_pending` sweep, called for an Organization that discovery named for that kind).
 * `DOCUMENT_LIST_PENDING_CLEANUP` lists exactly those, oldest deletion first by keyset
 * `(deleted_at, id)`, so nothing already recorded is touched; at most {@link CLEANUP_SCAN_PAGES}
 * pages of {@link LIST_PAGE} per pass. The list has no delay of its own, so the five-minute floor
 * stays here: the delete message normally runs the cleanup at once, and a document deleted more
 * recently than the floor is left to it instead of being cleaned twice. Returns how many cleanups
 * it completed.
 */
export async function cleanupPending(
  deps: PipelineDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<number> {
  let cursor = { at: '-infinity', id: '' }
  let cleaned = 0
  const oldEnough = deps.clock.now().getTime() - CLEANUP_PENDING_AFTER_MS
  for (let page = 0; page < CLEANUP_SCAN_PAGES && !signal.aborted; page++) {
    const rows = (
      await inTransaction(deps, organizationId, (run) =>
        run(DOCUMENT_LIST_PENDING_CLEANUP, [organizationId, cursor.at, cursor.id, LIST_PAGE])
      )
    ).rows
    for (const row of rows) {
      if (signal.aborted) {
        return cleaned
      }
      const deletedAt = pgTime(row.deleted_at)
      if (deletedAt === undefined) {
        continue
      }
      if (deletedAt.getTime() > oldEnough) {
        // Oldest first: everything after this is younger still.
        return cleaned
      }
      try {
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
      } catch (error) {
        // One document must not starve the ones behind it: report it and go on.
        reportWorkerError(deps, error, { worker: 'cleanup_pending', organizationId })
      }
    }
    const last = rows.at(-1)
    if (rows.length < LIST_PAGE || last === undefined) {
      break
    }
    cursor = { at: pgText(last.deleted_at), id: String(last.id) }
  }
  return cleaned
}
