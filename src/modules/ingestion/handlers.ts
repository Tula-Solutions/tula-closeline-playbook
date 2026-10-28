import type { Handlers } from 'tula-closeline-kit/queue'
import type { PlaybookEnvelope } from '~/messages'
import { cleanupCallDeletion } from '~/modules/call/purge'
import * as Exports from '~/modules/export/service'
import { handleEndedCall } from '~/modules/live-call/service'
import { proposeFromWonDeal } from '~/modules/suggestion/propose'
import { cleanupDeletion } from './cleanup'
import type { PipelineDeps } from './runtime'

/** What the uploaded-message handler tells the job loop. */
export type Nudge = (organizationId: string) => void

/**
 * The queue handlers (ADR 0016, 0018).
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
    // A nudge only: the re-tag job finds its work by discovery (`outcome_retag`), so a lost
    // message, or a change made before this handler existed, is recovered all the same.
    // Then a won Deal's Agent Calls are offered to the phraser; the proposal is idempotent by fingerprint.
    'playbook.deal_outcome_changed': async (message, context) => {
      if (context.organizationId === undefined) {
        return
      }
      nudge(context.organizationId)
      await proposeFromWonDeal(
        deps,
        context.organizationId,
        message.payload.dealRecordId,
        context.signal
      )
    },
    // A nudge too: the rebuild job is found by the `call_jobs` hint.
    'playbook.call_rep_changed': async (_message, context) => {
      if (context.organizationId !== undefined) {
        nudge(context.organizationId)
      }
    },
    'playbook.call_deleted': async (message, context) => {
      const organizationId = context.organizationId
      if (organizationId === undefined) {
        return
      }
      const result = await cleanupCallDeletion(
        deps,
        organizationId,
        message.payload.callId,
        message.payload.deletionSeq,
        context.signal
      )
      if (result === 'waiting') {
        // As for documents: acknowledge, and the `call_cleanup` sweep finishes it after the lease.
        deps.logger.info('a Call vector cleanup waits for a job lease; the sweep will finish it', {
          organizationId,
          callId: message.payload.callId,
        })
      }
    },
    // Voice's `voice.call.ended` (spec M12): an ended platform Call becomes a Call, or waits for its
    // Deal. Ids only are logged. A failure throws, so the queue redelivers; the handler is idempotent.
    'voice.call.ended': async (message, context) => {
      if (context.organizationId === undefined) {
        return
      }
      const result = await handleEndedCall(
        deps,
        context.organizationId,
        message.payload,
        context.signal
      )
      if (result === 'ingested') {
        nudge(context.organizationId)
      }
      deps.logger.info('an ended platform Call was handled', {
        organizationId: context.organizationId,
        callId: message.payload.callId,
        result,
      })
    },
    // Core's `export.requested`: write this service's slice and answer on core's jobs queue.
    'export.requested': async (message, context) => {
      if (context.organizationId === undefined) {
        return
      }
      await Exports.writeSlice(deps, {
        organizationId: context.organizationId,
        exportId: message.payload.exportId,
        includeRecordingLinks: message.payload.includeRecordingLinks,
        traceId: context.traceId,
        receiveCount: context.receiveCount,
        signal: context.signal,
      })
    },

    // Core's `prospect.erased`. No Playbook table has a Prospect key (db v0.22.0: Calls and Deals
    // link by `deal_record_id` only), so there is no row or vector to delete: the handler
    // acknowledges, which is the idempotent outcome for a redelivery or an unknown Prospect. It logs
    // the Organization only. When a table gains a Prospect key, delete by it here in bounded batches.
    'prospect.erased': async (_message, context) => {
      deps.logger.info('prospect erased: the Playbook holds no Prospect-keyed data', {
        organizationId: context.organizationId,
      })
    },
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
