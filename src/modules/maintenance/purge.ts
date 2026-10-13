import { DOCUMENT_PURGE_CLAIM, DOCUMENT_PURGE_COMPLETE } from 'tula-closeline-db'
import { cleanupDeletion } from '~/modules/ingestion/cleanup'
import { inTransaction, type PipelineDeps, within } from '~/modules/ingestion/runtime'
import { deleteAllVectorsOf, deleteDocumentObjects } from '~/modules/ingestion/vectors'

/** What one purge pass of an Organization did. */
export type PurgeResult = {
  /** Documents whose row is gone. */
  purged: number
  /** Documents claimed but not finished (their cleanup waits on a lease, or their row could not be completed yet). */
  deferred: number
}

/**
 * Purges the Organization's documents that are due (ADR 0016): claims a bounded batch under a
 * lease (the claim ends restores for good), deletes every vector of the document at any epoch (recording the
 * cleanup if it was not), removes the document's objects, and only then removes the row. A
 * document whose cleanup cannot run yet (a cancelled job's lease has not ended), or whose row
 * the database will not complete, stays deleted with its lease; the next pass takes it when the
 * lease ends. A document that was restored first is never claimed. When the last document of an
 * erased Organization goes, nothing else happens here: the remove-all route removes the rest.
 */
export async function purgeDue(
  deps: PipelineDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<PurgeResult> {
  const { env } = deps
  const claimed = await inTransaction(deps, organizationId, (run) =>
    run(DOCUMENT_PURGE_CLAIM, [organizationId, env.SWEEP_BATCH, env.PURGE_LEASE_MS])
  )
  const result: PurgeResult = { purged: 0, deferred: 0 }
  for (const row of claimed.rows) {
    if (signal.aborted) {
      break
    }
    const documentId = String(row.id)
    const deletionSeq = Number(row.deletion_seq)
    if (row.vectors_removed_seq === null || Number(row.vectors_removed_seq) !== deletionSeq) {
      const cleanup = await cleanupDeletion(deps, organizationId, documentId, deletionSeq, signal, {
        allEpochs: true,
      })
      if (cleanup !== 'done') {
        deps.logger.info('a purge waits for its vector cleanup', {
          organizationId,
          documentId,
          cleanup,
        })
        result.deferred++
        continue
      }
    } else {
      // Recorded earlier, perhaps only up to a recent epoch; the claim ended restores, so sweep all.
      await deleteAllVectorsOf(deps, organizationId, documentId, signal)
    }
    await deleteDocumentObjects(deps, organizationId, documentId, signal)
    // The original's own key too, in case it was written outside the document's prefix.
    await within(deps, 'object store', env.INGESTION_IO_TIMEOUT_MS, signal, () =>
      deps.objects.delete(organizationId, String(row.object_key))
    )
    const completed = await inTransaction(deps, organizationId, (run) =>
      run(DOCUMENT_PURGE_COMPLETE, [organizationId, documentId])
    )
    if (completed.rows.length > 0) {
      result.purged++
    } else {
      result.deferred++
    }
  }
  if (claimed.rows.length > 0) {
    deps.logger.info('a purge pass ended', { organizationId, ...result })
  }
  return result
}
