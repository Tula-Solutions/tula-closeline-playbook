import {
  CALL_CLEANUP_BEGIN,
  CALL_CLEANUP_DONE,
  CALL_LIST_PENDING_CLEANUP,
  CALL_LIST_SPENT_PURGES,
  CALL_PURGE_CLAIM,
  CALL_PURGE_COMPLETE,
} from 'tula-closeline-db'
import {
  CLEANUP_PENDING_AFTER_MS,
  inTransaction,
  MAX_STALE_EPOCHS,
  type PipelineDeps,
  reportWorkerError,
  within,
} from '~/modules/ingestion/runtime'
import { callPrefix } from './keys'

/** What the Call cleanup and purge need from the container. */
export type CallPurgeDeps = Pick<
  PipelineDeps,
  'scope' | 'sleep' | 'random' | 'vectors' | 'objects' | 'logger' | 'clock' | 'env'
>

/** What one Call purge pass of an Organization did. */
export type CallPurgeResult = {
  /** Calls whose row is gone. */
  purged: number
  /** Calls claimed but not finished (their cleanup waits on a lease, or their row could not be completed yet). */
  deferred: number
}

/** How a cleanup of one Call deletion ended. */
export type CallCleanupResult =
  /** The vectors are gone and the cleanup is recorded. */
  | 'done'
  /** The deletion no longer applies (the Call was restored, deleted again, or purged): nothing was done. */
  | 'moot'
  /** A job of the Call may still hold its lease: try again after it ends. */
  | 'waiting'

/**
 * Removes the vectors of one deletion of a Call: begins the cleanup for that `deletionSeq` (the
 * database answers only while the Call is deleted at exactly that sequence), waits while a job's
 * lease has not ended (that job cannot write vectors after it), deletes the Call's vectors up to
 * the epoch the database returned (one filter per epoch; equality filters only), and records it.
 * With `allEpochs` (a purge, or an erasure) every vector of the Call goes with one filter on its
 * id. Idempotent, and it does nothing for a deletion that a restore or a later delete outdated.
 */
export async function cleanupCallDeletion(
  deps: CallPurgeDeps,
  organizationId: string,
  callId: string,
  deletionSeq: number,
  signal: AbortSignal,
  options: { allEpochs?: boolean } = {}
): Promise<CallCleanupResult> {
  const begin = await inTransaction(deps, organizationId, (run) =>
    run(CALL_CLEANUP_BEGIN, [organizationId, callId, deletionSeq])
  )
  const row = begin.rows[0]
  if (row === undefined) {
    return 'moot'
  }
  if (row.clear !== true) {
    return 'waiting'
  }
  const timeout = deps.env.INGESTION_IO_TIMEOUT_MS
  if (options.allEpochs === true) {
    await within(deps, 'vector store', timeout, signal, () =>
      deps.vectors.deleteByFilter(organizationId, { call_id: callId })
    )
  } else {
    const upTo = Number(row.epoch)
    const from = Math.max(0, upTo - MAX_STALE_EPOCHS + 1)
    for (let epoch = from; epoch <= upTo; epoch++) {
      await within(deps, 'vector store', timeout, signal, () =>
        deps.vectors.deleteByFilter(organizationId, { call_id: callId, epoch })
      )
    }
    if (from > 0) {
      deps.logger.warn('older epochs of a Call were left to the search-time state check', {
        organizationId,
        callId,
        skippedBelow: from,
      })
    }
  }
  const done = await inTransaction(deps, organizationId, (run) =>
    run(CALL_CLEANUP_DONE, [organizationId, callId, deletionSeq])
  )
  return done.rows.length > 0 ? 'done' : 'moot'
}

/** Deletes every object under a Call's prefix, a bounded page at a time. */
async function deleteCallObjects(
  deps: CallPurgeDeps,
  organizationId: string,
  callId: string,
  signal: AbortSignal
): Promise<void> {
  const timeout = deps.env.INGESTION_IO_TIMEOUT_MS
  // Each page is deleted before the next is listed, so the listing starts over from the top.
  for (let pages = 0; pages < 20; pages++) {
    const page = await within(deps, 'object store', timeout, signal, () =>
      deps.objects.list(organizationId, { prefix: callPrefix(callId), limit: 100 })
    )
    for (const item of page.items) {
      await within(deps, 'object store', timeout, signal, () =>
        deps.objects.delete(organizationId, item.key)
      )
    }
    if (page.items.length === 0 || page.nextCursor === undefined) {
      break
    }
  }
}

/**
 * Purges the Organization's Calls that are due: claims a bounded batch under a lease (the claim
 * ends restores for good), runs the vector cleanup if it is not recorded, deletes every vector of
 * the Call, removes its objects, and only then removes the row. A Call whose cleanup cannot run yet
 * (a cancelled job's lease has not ended), or whose row the database will not complete, stays
 * deleted with its lease; the next pass takes it when the lease ends.
 */
export async function purgeCalls(
  deps: CallPurgeDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<CallPurgeResult> {
  const { env } = deps
  const claimed = await inTransaction(deps, organizationId, (run) =>
    run(CALL_PURGE_CLAIM, [organizationId, env.SWEEP_BATCH, env.PURGE_LEASE_MS])
  )
  const result: CallPurgeResult = { purged: 0, deferred: 0 }
  for (const row of claimed.rows) {
    if (signal.aborted) {
      break
    }
    const callId = String(row.id)
    const deletionSeq = Number(row.deletion_seq)
    const recorded =
      row.vectors_removed_seq !== null && Number(row.vectors_removed_seq) === deletionSeq
    const cleanup = recorded
      ? // Recorded earlier, perhaps only up to a recent epoch; the claim ended restores, so sweep all.
        await within(deps, 'vector store', env.INGESTION_IO_TIMEOUT_MS, signal, () =>
          deps.vectors.deleteByFilter(organizationId, { call_id: callId })
        ).then(() => 'done' as const)
      : await cleanupCallDeletion(deps, organizationId, callId, deletionSeq, signal, {
          allEpochs: true,
        })
    if (cleanup !== 'done') {
      deps.logger.info('a Call purge waits for its vector cleanup', {
        organizationId,
        callId,
        cleanup,
      })
      result.deferred++
      continue
    }
    await deleteCallObjects(deps, organizationId, callId, signal)
    // The original's and the kept Transcript's own keys too, in case they were written outside the prefix.
    for (const key of [row.object_key, row.transcript_key]) {
      if (typeof key === 'string') {
        await within(deps, 'object store', env.INGESTION_IO_TIMEOUT_MS, signal, () =>
          deps.objects.delete(organizationId, key)
        )
      }
    }
    const completed = await inTransaction(deps, organizationId, (run) =>
      run(CALL_PURGE_COMPLETE, [organizationId, callId])
    )
    if (completed.rows.length > 0) {
      result.purged++
    } else {
      result.deferred++
    }
  }
  if (claimed.rows.length > 0) {
    deps.logger.info('a Call purge pass ended', { organizationId, ...result })
  }
  return result
}

/** The pages of pending cleanups one Organization's pass reads, and the Calls on one page. */
const PENDING_PAGES = 5
const PENDING_PAGE_SIZE = 100

/** Consecutive failed cleanups after which an Organization's pass stops. */
const PENDING_MAX_FAILURES = 3

/**
 * Runs the vector cleanup of the Organization's deleted Calls whose cleanup is not recorded (the
 * `call_cleanup` sweep). Oldest deletion first by the statement's keyset; a Call deleted less than
 * five minutes ago is left to its message. One Call that keeps failing does not starve the rest,
 * but a store that keeps failing ends the pass. Returns how many cleanups it completed.
 */
export async function cleanupPendingCalls(
  deps: PipelineDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<number> {
  let cursor = { at: '-infinity', id: '' }
  let cleaned = 0
  let failures = 0
  const oldEnough = deps.clock.now().getTime() - CLEANUP_PENDING_AFTER_MS
  for (let page = 0; page < PENDING_PAGES && !signal.aborted; page++) {
    const rows = (
      await inTransaction(deps, organizationId, (run) =>
        run(CALL_LIST_PENDING_CLEANUP, [organizationId, cursor.at, cursor.id, PENDING_PAGE_SIZE])
      )
    ).rows
    for (const row of rows) {
      if (signal.aborted) {
        return cleaned
      }
      const deletedAt = new Date(String(row.deleted_at)).getTime()
      if (Number.isFinite(deletedAt) && deletedAt > oldEnough) {
        return cleaned
      }
      try {
        const result = await cleanupCallDeletion(
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
        reportWorkerError(deps, error, { worker: 'call_cleanup', organizationId })
        if (++failures >= PENDING_MAX_FAILURES) {
          return cleaned
        }
      }
    }
    const last = rows.at(-1)
    if (rows.length < PENDING_PAGE_SIZE || last === undefined) {
      break
    }
    cursor = { at: String(last.cursor_at), id: String(last.id) }
  }
  return cleaned
}

/** The most spent purges one listing reads. */
const SPENT_PAGE = 50

/**
 * Lists the Organization's Calls whose purge gave up (it reached the attempt bound) and logs them
 * at error level, ids and counts only. A person fixes what blocked the purge; this service never
 * resets it. Returns how many were listed.
 */
export async function logSpentCallPurges(
  deps: CallPurgeDeps,
  organizationId: string
): Promise<number> {
  const result = await inTransaction(deps, organizationId, (run) =>
    run(CALL_LIST_SPENT_PURGES, [organizationId, '', SPENT_PAGE])
  )
  if (result.rows.length > 0) {
    deps.logger.error('Call purges have given up and need a person', {
      organizationId,
      calls: result.rows.map((row) => String(row.id)),
      attempts: result.rows.map((row) => Number(row.purge_attempts)),
      listedAtMost: SPENT_PAGE,
    })
  }
  return result.rows.length
}
