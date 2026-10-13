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

/** Consecutive failed cleanups after which an Organization's pass stops (a success resets the count). */
export const CLEANUP_MAX_CONSECUTIVE_FAILURES = 3

/** How long a failing document is reported once; later failures inside the window only log a warning. */
export const CLEANUP_REPORT_WINDOW_MS = 30 * 60 * 1000

/** The most failing documents remembered for that deduplication (the oldest are dropped first). */
export const CLEANUP_REPORT_MEMORY = 1000

/** Failing documents already reported, by `organizationId:documentId` to the time the report expires. For deduplication only. */
const reported = new Map<string, number>()

/** Reports a failing cleanup once per window and document; a repeat is a warning with ids only. */
function reportFailure(
  deps: PipelineDeps,
  error: unknown,
  organizationId: string,
  documentId: string
): void {
  const now = deps.clock.now().getTime()
  const key = `${organizationId}:${documentId}`
  const until = reported.get(key)
  if (until !== undefined && until > now) {
    deps.logger.warn('a pending cleanup failed again', { organizationId, documentId })
    return
  }
  reported.delete(key)
  if (reported.size >= CLEANUP_REPORT_MEMORY) {
    for (const [other, expires] of reported) {
      if (expires <= now) {
        reported.delete(other)
      }
    }
    // Still full: drop the oldest entry (a Map iterates in insertion order).
    const oldest = reported.keys().next()
    if (reported.size >= CLEANUP_REPORT_MEMORY && !oldest.done) {
      reported.delete(oldest.value)
    }
  }
  reported.set(key, now + CLEANUP_REPORT_WINDOW_MS)
  reportWorkerError(deps, error, { worker: 'cleanup_pending', organizationId })
}

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
  let failures = 0
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
        failures = 0
        if (result === 'done') {
          cleaned++
        }
      } catch (error) {
        // One document must not starve the ones behind it: report it and go on, but a store that
        // keeps failing ends the pass instead of waiting out a timeout per document.
        reportFailure(deps, error, organizationId, String(row.id))
        if (++failures >= CLEANUP_MAX_CONSECUTIVE_FAILURES) {
          return cleaned
        }
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
