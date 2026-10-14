import type { Handlers } from 'tula-closeline-kit/queue'
import type { PlaybookEnvelope } from '~/messages'
import { cleanupDeletion } from './cleanup'
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
 * `playbook.document_deleted` removes the vectors of that deletion only, once. When a cancelled
 * job's lease has not ended it does not wait (a few such deletes would hold every consumer slot):
 * it logs and acknowledges, and the `cleanup_pending` sweep finishes the cleanup. A message whose
 * deletion no longer applies is acknowledged without doing anything.
 */
export function ingestionHandlers(deps: PipelineDeps, nudge: Nudge): Handlers<PlaybookEnvelope> {
  return {
    'playbook.document_uploaded': async (_message, context) => {
      if (context.organizationId !== undefined) {
        nudge(context.organizationId)
      }
    },
    // Acknowledged and dropped for now. A lost message is recovered by a discovery of Calls whose
    // tag lags the Deal's `outcome_seq`; that discovery is in db v0.15.0 and the service Calls
    // ticket, not in this repo yet. Until then the message is simply consumed.
    'playbook.deal_outcome_changed': async () => undefined,
    'playbook.document_deleted': async (message, context) => {
      const organizationId = context.organizationId
      if (organizationId === undefined) {
        return
      }
      const result = await cleanupDeletion(
        deps,
        organizationId,
        message.payload.documentId,
        message.payload.deletionSeq,
        context.signal
      )
      if (result === 'waiting') {
        // The kit has no way to ask for a retry without an error report (a throw is logged at
        // error level and reported), and waiting here would hold a consumer slot for up to the
        // lease. The message is acknowledged; the `cleanup_pending` sweep, which finds a deleted
        // document whose cleanup is not recorded five minutes after the delete, finishes it.
        deps.logger.info('a vector cleanup waits for a job lease; the sweep will finish it', {
          organizationId,
          documentId: message.payload.documentId,
        })
      }
    },
  }
}
