import {
  CONSUMED_PURGE_AGE_MS,
  DEAL_IMPORT_GET,
  DOCUMENT_GET,
  DOCUMENT_LIST_SPENT_PURGES,
  IDEMPOTENCY_PURGE,
  IDEMPOTENCY_PURGE_AGE_MS,
  ORPHAN_SWEEP_DONE,
} from 'tula-closeline-db'
import type { ProcessedStore } from 'tula-closeline-kit'
import { isLockTimeout } from '~/adapters/postgres/retry'
import { importIdOfKey } from '~/modules/deal-import/keys'
import { inTransaction, type PipelineDeps, within } from '~/modules/ingestion/runtime'

/**
 * The youngest an object with no document may be before the orphan sweep deletes it: 24 hours, the
 * database's rule (the orphan sweep's 25-hour age and the 26-hour key purge are built on it), so it
 * is a constant and not a setting: above it the sweep would skip objects and still declare them
 * swept, below it a young upload's object could be deleted.
 */
export const ORPHAN_OBJECT_MIN_AGE_MS = 24 * 60 * 60 * 1000

/** The rounds one purge repeats while its batches come back full. */
const MAX_PURGE_ROUNDS = 20

/** The spent purges listed per Organization per pass. */
const SPENT_PAGE = 20

/**
 * Purges the Organization's idempotency keys older than {@link IDEMPOTENCY_PURGE_AGE_MS}
 * (26 hours: an hour more than the orphan sweep's age, which the statement enforces), a batch
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

/** One kind of object the orphan sweep looks after: where it lives, how its key names its owner, and whether the owner still needs it. */
type OrphanKind = {
  prefix: string
  ownerOf: (key: string) => string | undefined
  /** Whether the owners in `ids` still need their object: a document with a row, an import still waiting for or running its job. */
  needed: (
    deps: PipelineDeps,
    organizationId: string,
    ids: readonly string[]
  ) => Promise<Set<string>>
}

const ORPHAN_KINDS: readonly OrphanKind[] = [
  {
    prefix: 'documents/',
    ownerOf: documentIdOfKey,
    needed: (deps, organizationId, ids) =>
      inTransaction(deps, organizationId, async (run) => {
        const found = new Set<string>()
        for (const id of ids) {
          if ((await run(DOCUMENT_GET, [organizationId, id])).rows.length > 0) {
            found.add(id)
          }
        }
        return found
      }),
  },
  {
    prefix: 'deal-imports/',
    ownerOf: importIdOfKey,
    // A CSV is needed only while its import can still run. An import that ended keeps no file
    // (the job removes it), so one left behind by a failed removal is swept like an orphan.
    needed: (deps, organizationId, ids) =>
      inTransaction(deps, organizationId, async (run) => {
        const found = new Set<string>()
        for (const id of ids) {
          const row = (await run(DEAL_IMPORT_GET, [organizationId, id])).rows[0]
          if (row?.state === 'uploaded' || row?.state === 'processing') {
            found.add(id)
          }
        }
        return found
      }),
  },
]

/**
 * Deletes the Organization's objects under `documents/` that no document names and under
 * `deal-imports/` that no waiting or running import names, when they are older than
 * {@link ORPHAN_OBJECT_MIN_AGE_MS} (an upload whose outcome was unknown leaves one, and so does an
 * ended import whose file could not be removed). Each listing is paged (`ORPHAN_PAGE_SIZE`, at most
 * `ORPHAN_MAX_PAGES` pages a pass); an object is deleted only when its owner no longer needs it and
 * its last write is old, so an upload in progress, whose object is young, is never touched. An
 * object under another prefix, or with a key of another shape, is left alone. Returns the objects deleted.
 */
export async function sweepOrphanObjects(
  deps: PipelineDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<number> {
  return (await sweepOrphanObjectsOnce(deps, organizationId, signal)).deleted
}

/** What one orphan sweep did. */
export type OrphanSweepResult = {
  /** Objects deleted. */
  deleted: number
  /** Whether every object under both prefixes was examined (the page bound and a cancel can cut it short). */
  complete: boolean
}

/** {@link sweepOrphanObjects} that also says whether the whole listing was examined. */
export async function sweepOrphanObjectsOnce(
  deps: PipelineDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<OrphanSweepResult> {
  const { env } = deps
  const oldest = deps.clock.now().getTime() - ORPHAN_OBJECT_MIN_AGE_MS
  let deleted = 0
  let complete = true
  for (const kind of ORPHAN_KINDS) {
    let cursor: string | undefined
    let kindComplete = false
    for (let page = 0; page < env.ORPHAN_MAX_PAGES && !signal.aborted; page++) {
      const listed = await within(deps, 'object store', env.INGESTION_IO_TIMEOUT_MS, signal, () =>
        deps.objects.list(organizationId, {
          prefix: kind.prefix,
          limit: env.ORPHAN_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        })
      )
      const old = listed.items.filter((item) => item.lastModified.getTime() < oldest)
      const ids = [...new Set(old.flatMap((item) => kind.ownerOf(item.key) ?? []))]
      if (ids.length > 0) {
        const needed = await kind.needed(deps, organizationId, ids)
        for (const item of old) {
          const id = kind.ownerOf(item.key)
          if (id !== undefined && !needed.has(id)) {
            await within(deps, 'object store', env.INGESTION_IO_TIMEOUT_MS, signal, () =>
              deps.objects.delete(organizationId, item.key)
            )
            deleted++
          }
        }
      }
      cursor = listed.nextCursor
      if (cursor === undefined) {
        kindComplete = true
        break
      }
    }
    complete = complete && kindComplete
  }
  if (deleted > 0) {
    deps.logger.info('objects with no owner were deleted', { organizationId, objects: deleted })
  }
  return { deleted, complete: complete && !signal.aborted }
}

/** The statement every orphan-sweep completion starts with: it waits for open uploads, so only briefly. */
const ORPHAN_DONE_LOCK_TIMEOUT_SQL = "set local lock_timeout = '1s'"

/** How one visit to an Organization for the `orphan_sweep` kind ended. */
export type OrphanVisit =
  /** Swept and marked done; `more` says a newer upload attempt keeps the Organization named. */
  | { status: 'done'; deleted: number; more: boolean }
  /** The listing was cut short; nothing is marked, and the next tick sweeps again. */
  | { status: 'incomplete'; deleted: number }
  /** `ORPHAN_SWEEP_DONE` waited past its lock timeout (an upload or an erasure is open); the next tick tries again. */
  | { status: 'busy'; deleted: number }

/**
 * One visit for the `orphan_sweep` work kind: sweeps the Organization's orphan objects, then records
 * it with `ORPHAN_SWEEP_DONE`. The `$2` time is taken before the sweep starts, not when done is
 * called: an object stored while the sweep ran may have been missed, and a later time would count
 * it as examined. Done runs under a short `lock_timeout`; a timeout is `busy`, tried again at the
 * next tick without an error report. A listing cut short is not marked.
 */
export async function visitOrphanSweep(
  deps: PipelineDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<OrphanVisit> {
  const startedAt = deps.clock.now()
  const { deleted, complete } = await sweepOrphanObjectsOnce(deps, organizationId, signal)
  if (!complete) {
    return { status: 'incomplete', deleted }
  }
  try {
    const done = await inTransaction(deps, organizationId, async (run) => {
      await run(ORPHAN_DONE_LOCK_TIMEOUT_SQL, [])
      return run(ORPHAN_SWEEP_DONE, [organizationId, startedAt.toISOString()])
    })
    return { status: 'done', deleted, more: done.rows[0]?.more === true }
  } catch (error) {
    if (isLockTimeout(error)) {
      return { status: 'busy', deleted }
    }
    throw error
  }
}
