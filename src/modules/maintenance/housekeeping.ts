import {
  CONSUMED_PURGE_AGE_MS,
  DOCUMENT_GET,
  DOCUMENT_LIST_SPENT_PURGES,
  IDEMPOTENCY_PURGE,
  IDEMPOTENCY_PURGE_AGE_MS,
} from 'tula-closeline-db'
import type { ProcessedStore } from 'tula-closeline-kit'
import { inTransaction, type PipelineDeps, within } from '~/modules/ingestion/runtime'

/** The rounds one purge repeats while its batches come back full. */
const MAX_PURGE_ROUNDS = 20

/** The spent purges listed per Organization per pass. */
const SPENT_PAGE = 20

/**
 * Purges the Organization's idempotency keys older than {@link IDEMPOTENCY_PURGE_AGE_MS}, a batch
 * at a time, repeating while a batch comes back full (a short batch means the backlog is done;
 * the database's own note says to repeat until one removes none, so a full batch repeats and a
 * short one is followed by one more look) up to {@link MAX_PURGE_ROUNDS} rounds. Returns the rows removed.
 */
export async function purgeIdempotencyKeys(
  deps: PipelineDeps,
  organizationId: string
): Promise<number> {
  const { env } = deps
  let removed = 0
  for (let round = 0; round < MAX_PURGE_ROUNDS; round++) {
    const result = await inTransaction(deps, organizationId, (run) =>
      run(IDEMPOTENCY_PURGE, [organizationId, IDEMPOTENCY_PURGE_AGE_MS, env.HOUSEKEEPING_BATCH])
    )
    removed += result.rowCount
    if (result.rowCount === 0) {
      break
    }
  }
  return removed
}

/**
 * Purges consumed-message records older than the queue's retention (15 days) through the
 * processed store's `purge`, which finds the Organizations itself. Repeats while a call removes
 * as many as it was allowed. Returns the records removed.
 */
export async function purgeConsumedMessages(
  deps: PipelineDeps,
  processed: ProcessedStore
): Promise<number> {
  const before = new Date(deps.clock.now().getTime() - CONSUMED_PURGE_AGE_MS)
  const limit = deps.env.HOUSEKEEPING_BATCH * 10
  let removed = 0
  for (let round = 0; round < MAX_PURGE_ROUNDS; round++) {
    const count = await processed.purge(before, limit)
    removed += count
    if (count < limit) {
      break
    }
  }
  return removed
}

/**
 * Lists the Organization's documents whose purge gave up (it reached the attempt bound) and logs
 * them at error level, ids and counts only. A person fixes what blocked the purge and resets it
 * (`DOCUMENT_PURGE_RESET`); this service never does. Returns how many were listed.
 */
export async function logSpentPurges(deps: PipelineDeps, organizationId: string): Promise<number> {
  const result = await inTransaction(deps, organizationId, (run) =>
    run(DOCUMENT_LIST_SPENT_PURGES, [organizationId, '', SPENT_PAGE])
  )
  if (result.rows.length > 0) {
    deps.logger.error('purges have given up and need a person', {
      organizationId,
      documents: result.rows.map((row) => String(row.id)),
      attempts: result.rows.map((row) => Number(row.purge_attempts)),
      listedAtMost: SPENT_PAGE,
    })
  }
  return result.rows.length
}

/** The id inside an object key `documents/<id>/<file>`, or `undefined` for any other key. */
export function documentIdOfKey(key: string): string | undefined {
  const match = /^documents\/(doc_[0-9a-f]{32})\/[^/]+$/.exec(key)
  return match?.[1]
}

/**
 * Deletes the Organization's objects under `documents/` that no document names and that are older
 * than `ORPHAN_MIN_AGE_MS` (an upload whose outcome was unknown leaves one). The listing is paged
 * (`ORPHAN_PAGE_SIZE`, at most `ORPHAN_MAX_PAGES` pages a pass); an object is deleted only when
 * its document id has no row and its last write is old, so an upload in progress, whose object
 * is young, is never touched. An object under another prefix, or with a key of another shape,
 * is left alone. Returns the objects deleted.
 */
export async function sweepOrphanObjects(
  deps: PipelineDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<number> {
  const { env } = deps
  const oldest = deps.clock.now().getTime() - env.ORPHAN_MIN_AGE_MS
  let cursor: string | undefined
  let deleted = 0
  for (let page = 0; page < env.ORPHAN_MAX_PAGES && !signal.aborted; page++) {
    const listed = await within(deps, 'object store', env.INGESTION_IO_TIMEOUT_MS, signal, () =>
      deps.objects.list(organizationId, {
        prefix: 'documents/',
        limit: env.ORPHAN_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      })
    )
    const old = listed.items.filter((item) => item.lastModified.getTime() < oldest)
    const ids = [...new Set(old.flatMap((item) => documentIdOfKey(item.key) ?? []))]
    if (ids.length > 0) {
      const existing = await inTransaction(deps, organizationId, async (run) => {
        const found = new Set<string>()
        for (const id of ids) {
          if ((await run(DOCUMENT_GET, [organizationId, id])).rows.length > 0) {
            found.add(id)
          }
        }
        return found
      })
      for (const item of old) {
        const id = documentIdOfKey(item.key)
        if (id !== undefined && !existing.has(id)) {
          await within(deps, 'object store', env.INGESTION_IO_TIMEOUT_MS, signal, () =>
            deps.objects.delete(organizationId, item.key)
          )
          deleted++
        }
      }
    }
    cursor = listed.nextCursor
    if (cursor === undefined) {
      break
    }
  }
  if (deleted > 0) {
    deps.logger.info('objects with no document were deleted', { organizationId, objects: deleted })
  }
  return deleted
}
