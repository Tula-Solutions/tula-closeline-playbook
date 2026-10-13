import { DOCUMENT_CLEANUP_BEGIN, DOCUMENT_CLEANUP_DONE } from 'tula-closeline-db'
import { inTransaction, type PipelineDeps } from './runtime'
import { deleteVectorsUpTo } from './vectors'

/** How a cleanup of one deletion ended. */
export type CleanupResult =
  /** The vectors are gone and the cleanup is recorded. */
  | 'done'
  /** The deletion no longer applies (the document was restored, deleted again, or purged): nothing was done. */
  | 'moot'
  /** A job of the document may still hold its lease: try again after it ends. */
  | 'waiting'

/** How often a cleanup that must wait for a lease looks again, in ms. */
const WAIT_STEP_MS = 2_000

/**
 * Removes the vectors of one deletion of a document: begins the cleanup for that `deletionSeq`
 * (the database answers only while the document is deleted at exactly that sequence), refuses to
 * go on while a cancelled or running job's lease has not ended (that job cannot write vectors
 * after it), deletes the document's vectors up to the epoch the database returned, and records it.
 * Idempotent, and it does nothing for a deletion that a restore or a later delete has outdated.
 */
export async function cleanupDeletion(
  deps: PipelineDeps,
  organizationId: string,
  documentId: string,
  deletionSeq: number,
  signal: AbortSignal
): Promise<CleanupResult> {
  const begin = await inTransaction(deps, organizationId, (run) =>
    run(DOCUMENT_CLEANUP_BEGIN, [organizationId, documentId, deletionSeq])
  )
  const row = begin.rows[0]
  if (row === undefined) {
    return 'moot'
  }
  if (row.clear !== true) {
    return 'waiting'
  }
  await deleteVectorsUpTo(deps, organizationId, documentId, Number(row.epoch), signal)
  const done = await inTransaction(deps, organizationId, (run) =>
    run(DOCUMENT_CLEANUP_DONE, [organizationId, documentId, deletionSeq])
  )
  return done.rows.length > 0 ? 'done' : 'moot'
}

/**
 * {@link cleanupDeletion}, waiting for a job's lease to end for up to the lease length plus a
 * margin. Still waiting after that is returned as `waiting` for the caller to retry later.
 */
export async function cleanupDeletionPatiently(
  deps: PipelineDeps,
  organizationId: string,
  documentId: string,
  deletionSeq: number,
  signal: AbortSignal
): Promise<CleanupResult> {
  const deadline = deps.clock.now().getTime() + deps.env.INGESTION_LEASE_MS + 5_000
  for (;;) {
    const result = await cleanupDeletion(deps, organizationId, documentId, deletionSeq, signal)
    if (result !== 'waiting' || signal.aborted || deps.clock.now().getTime() >= deadline) {
      return result
    }
    await deps.sleep(WAIT_STEP_MS, signal)
  }
}
