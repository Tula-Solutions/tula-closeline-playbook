import type { Handlers } from 'tula-closeline-kit/queue'
import type { PlaybookEnvelope } from '~/messages'
import { cleanupDeletionPatiently } from './cleanup'
import type { PipelineDeps } from './runtime'

/** What the uploaded-message handler tells the job loop. */
export type Nudge = (organizationId: string) => void

/**
 * The two queue handlers (ADR 0016).
 *
 * `playbook.document_uploaded` is a nudge: the job row is the source of truth, found by the loop
 * without any message, so the handler only asks the loop to look at this Organization now and
 * returns. Losing the nudge costs latency, never a document.
 *
 * `playbook.document_deleted` removes the vectors of that deletion only. It waits (within the
 * consumer's handler timeout) for a cancelled job's lease to end; if that takes too long it
 * throws and the queue delivers the message again later. A message whose deletion no longer
 * applies is acknowledged without doing anything.
 */
export function ingestionHandlers(deps: PipelineDeps, nudge: Nudge): Handlers<PlaybookEnvelope> {
  return {
    'playbook.document_uploaded': async (_message, context) => {
      if (context.organizationId !== undefined) {
        nudge(context.organizationId)
      }
    },
    'playbook.document_deleted': async (message, context) => {
      const organizationId = context.organizationId
      if (organizationId === undefined) {
        return
      }
      const result = await cleanupDeletionPatiently(
        deps,
        organizationId,
        message.payload.documentId,
        message.payload.deletionSeq,
        context.signal
      )
      if (result === 'waiting') {
        throw new Error('the vector cleanup waits for an ingestion job to release the document')
      }
    },
  }
}
