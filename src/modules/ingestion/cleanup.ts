import { DOCUMENT_CLEANUP_BEGIN, DOCUMENT_CLEANUP_DONE } from 'tula-closeline-db'
import { inTransaction, type PipelineDeps } from './runtime'
import { deleteAllVectorsOf, deleteVectorsUpTo } from './vectors'

/** How a cleanup of one deletion ended. */
export type CleanupResult =
  /** The vectors are gone and the cleanup is recorded. */
  | 'done'
  /** The deletion no longer applies (the document was restored, deleted again, or purged): nothing was done. */
  | 'moot'
  /** A job of the document may still hold its lease: try again after it ends. */
  | 'waiting'

/**
 * Removes the vectors of one deletion of a document: begins the cleanup for that `deletionSeq`
 * (the database answers only while the document is deleted at exactly that sequence), refuses to
 * go on while a cancelled or running job's lease has not ended (that job cannot write vectors
 * after it), deletes the document's vectors up to the epoch the database returned, and records it.
 * With `allEpochs` (a purge only) every vector of the document goes. Idempotent, and it does nothing for a deletion that a restore or a later delete has outdated.
 */
export async function cleanupDeletion(
  deps: PipelineDeps,
  organizationId: string,
  documentId: string,
  deletionSeq: number,
  signal: AbortSignal,
  options: { allEpochs?: boolean } = {}
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
  if (options.allEpochs === true) {
    // A purge: restore is impossible, so every epoch goes, however many times it was restored.
    await deleteAllVectorsOf(deps, organizationId, documentId, signal)
  } else {
    await deleteVectorsUpTo(deps, organizationId, documentId, Number(row.epoch), signal)
  }
  const done = await inTransaction(deps, organizationId, (run) =>
    run(DOCUMENT_CLEANUP_DONE, [organizationId, documentId, deletionSeq])
  )
  return done.rows.length > 0 ? 'done' : 'moot'
}
