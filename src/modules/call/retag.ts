import { MEDIA_TYPE_BY_CALL_EXTENSION } from 'tula-closeline-contract'
import {
  CALL_GET,
  CALL_RETAGGED,
  DEAL_GET,
  DEAL_LIST_PENDING_RETAG,
  DEAL_RETAG_BATCH,
  DEAL_RETAG_DONE,
  DEAL_RETAG_LOCK,
} from 'tula-closeline-db'
import { toTextArrayLiteral } from '~/adapters/postgres/text-array'
import {
  inTransaction,
  type PipelineDeps,
  reportWorkerError,
  within,
} from '~/modules/ingestion/runtime'
import { callObjectKey } from './keys'
import { writeMomentVectors } from './moment-vectors'
import { buildMoments } from './moments'
import { parseTranscript, type TranscriptMediaType } from './transcript'

/** The Deals one Organization's pass re-tags; the rest wait for the next pass. */
export const RETAG_DEALS_PER_PASS = 5

/** The Calls of a Deal one batch statement reads (the database clamps it to 500). */
export const RETAG_CALLS_PER_BATCH = 10

/** The rounds one Deal gets in a pass: each is a full pass over its stale Calls and then the completion. */
export const RETAG_ROUNDS = 3

/** The times one Call's vectors are written again because the Deal's Outcome moved while they were written. */
const RETAG_CALL_ATTEMPTS = 4

/** What one re-tag pass of an Organization did. */
export type RetagResult = {
  /** Deals whose re-tag is complete (`retag_through` reached their sequence). */
  deals: number
  /** Calls whose tag was rewritten. */
  calls: number
  /** Calls left stale for the next pass (unreadable, or the Outcome kept moving). */
  skipped: number
}

/** How one Call's re-tag ended. */
/** The key of a Transcript Call's original file, rebuilt from its media type, which maps to one extension. */
function objectKeyOf(callId: string, mediaType: string): string | undefined {
  const extension = Object.entries(MEDIA_TYPE_BY_CALL_EXTENSION).find(
    ([, type]) => type === mediaType
  )?.[0]
  return extension === undefined ? undefined : callObjectKey(callId, extension)
}

type CallResult = 'tagged' | 'skipped'

/**
 * Re-tags one ready Call to the Deal's Outcome: rebuilds its Moments from the kept Transcript,
 * embeds them and writes the vectors again under the same ids with the new tag, then records it
 * with `CALL_RETAGGED`. Vector attributes cannot be updated in place, so this is a re-embed.
 *
 * Convergence: after the write the Deal is read again; if its sequence moved past the one written,
 * the write is repeated at the newer sequence before anything is recorded, so a slower instance's
 * older write cannot be the last word (it re-checks after writing). After the record the Call is
 * read again: if it was deleted, restored or had its Rep changed meanwhile, the vectors this build
 * wrote are removed (the cleanup of that change may already have run). Idempotent and resumable:
 * the database lists only Calls whose tag is behind.
 */
async function retagCall(
  deps: PipelineDeps,
  organizationId: string,
  callId: string,
  dealRecordId: string,
  first: { outcome: string; outcomeSeq: number },
  signal: AbortSignal
): Promise<CallResult> {
  const timeout = deps.env.INGESTION_IO_TIMEOUT_MS
  let tag = first
  for (let attempt = 0; attempt < RETAG_CALL_ATTEMPTS; attempt++) {
    const call = await inTransaction(
      deps,
      organizationId,
      async (run) => (await run(CALL_GET, [organizationId, callId])).rows[0]
    )
    if (call === undefined || call.state !== 'ready') {
      return 'skipped'
    }
    const epoch = Number(call.epoch)
    const repSeq = Number(call.rep_seq)
    if (
      call.kind !== 'transcript' ||
      call.rep_label === null ||
      objectKeyOf(callId, String(call.media_type)) === undefined
    ) {
      // Recordings keep their Transcript elsewhere; they are not re-tagged by this code yet.
      return 'skipped'
    }
    const object = await within(deps, 'object store', timeout, signal, () =>
      deps.objects.get(organizationId, objectKeyOf(callId, String(call.media_type)) ?? '')
    )
    if (object === undefined) {
      return 'skipped'
    }
    const parsed = parseTranscript(object.body, call.media_type as TranscriptMediaType)
    if (!parsed.ok) {
      return 'skipped'
    }
    const moments = buildMoments(parsed.transcript.turns, String(call.rep_label))
    await writeMomentVectors(
      {
        deps,
        organizationId,
        callId,
        epoch,
        repSeq,
        signal,
        beforeWrite: async () => signal.throwIfAborted(),
      },
      moments,
      tag
    )
    const deal = await inTransaction(
      deps,
      organizationId,
      async (run) => (await run(DEAL_GET, [organizationId, dealRecordId])).rows[0]
    )
    if (deal === undefined) {
      return 'skipped'
    }
    if (Number(deal.outcome_seq) !== tag.outcomeSeq) {
      tag = { outcome: String(deal.outcome), outcomeSeq: Number(deal.outcome_seq) }
      continue
    }
    const recorded = await inTransaction(deps, organizationId, async (run) => {
      const rows = (
        await run(CALL_RETAGGED, [organizationId, toTextArrayLiteral([callId]), tag.outcomeSeq])
      ).rows
      const after = (await run(CALL_GET, [organizationId, callId])).rows[0]
      return { recorded: rows.length > 0, after }
    })
    const after = recorded.after
    if (
      after === undefined ||
      after.state === 'deleted' ||
      Number(after.epoch) !== epoch ||
      Number(after.rep_seq) !== repSeq
    ) {
      // The Call moved on while its vectors were written: remove what this build wrote.
      await within(deps, 'vector store', timeout, signal, () =>
        deps.vectors.deleteByFilter(organizationId, {
          call_id: callId,
          epoch,
          rep_seq: repSeq,
        })
      )
      return 'skipped'
    }
    return 'tagged'
  }
  return 'skipped'
}

/**
 * Takes one Deal toward `retag_through = outcome_seq`: batches of its stale ready Calls are
 * re-tagged, then `DEAL_RETAG_LOCK` and `DEAL_RETAG_DONE` run in one short transaction (the lock
 * takes the Deal row, so a completion or an Outcome change that is open holds it back or goes
 * after it). `DEAL_RETAG_DONE` refuses while a ready Call is stale, which is how a Call that
 * finished mid-re-tag, or an Outcome that moved, brings another round; after {@link RETAG_ROUNDS}
 * rounds the Deal is left for the next pass (discovery still names it). Returns the Calls tagged
 * and whether the Deal is complete.
 */
async function retagDeal(
  deps: PipelineDeps,
  organizationId: string,
  dealRecordId: string,
  signal: AbortSignal
): Promise<{ calls: number; skipped: number; complete: boolean }> {
  let calls = 0
  const skippedIds = new Set<string>()
  for (let round = 0; round < RETAG_ROUNDS && !signal.aborted; round++) {
    let after = ''
    for (;;) {
      signal.throwIfAborted()
      const batch = await inTransaction(
        deps,
        organizationId,
        async (run) =>
          (
            await run(DEAL_RETAG_BATCH, [
              organizationId,
              dealRecordId,
              after,
              RETAG_CALLS_PER_BATCH,
            ])
          ).rows
      )
      for (const row of batch) {
        after = String(row.id)
        try {
          const result = await retagCall(
            deps,
            organizationId,
            String(row.id),
            dealRecordId,
            { outcome: String(row.outcome), outcomeSeq: Number(row.outcome_seq) },
            signal
          )
          if (result === 'tagged') {
            calls++
          } else {
            skippedIds.add(String(row.id))
          }
        } catch (error) {
          if (signal.aborted) {
            throw error
          }
          skippedIds.add(String(row.id))
          reportWorkerError(deps, error, { worker: 'retag', organizationId })
        }
      }
      if (batch.length < RETAG_CALLS_PER_BATCH) {
        break
      }
    }
    const done = await inTransaction(deps, organizationId, async (run) => {
      const locked = (await run(DEAL_RETAG_LOCK, [organizationId, dealRecordId])).rows[0]
      if (locked === undefined) {
        return 'gone' as const
      }
      if (Number(locked.retag_through) >= Number(locked.outcome_seq)) {
        return 'done' as const
      }
      const finished = (
        await run(DEAL_RETAG_DONE, [organizationId, dealRecordId, Number(locked.outcome_seq)])
      ).rows
      return finished.length > 0 ? ('done' as const) : ('stale' as const)
    })
    if (done !== 'stale') {
      return { calls, skipped: skippedIds.size, complete: done === 'done' }
    }
  }
  return { calls, skipped: skippedIds.size, complete: false }
}

/**
 * The Outcome re-tag of one Organization, driven by discovery (`outcome_retag`): lists up to
 * {@link RETAG_DEALS_PER_PASS} Deals whose `retag_through` is behind their `outcome_seq`
 * (`DEAL_LIST_PENDING_RETAG`) and re-tags each. It reads the database, never a message: an
 * Outcome-changed message only nudges the same pass, so a lost message, and a change made before
 * this job existed, are both found. A Deal that cannot finish (an unreadable Call) is left and
 * reported, and does not hold up the others. Nothing it logs holds Transcript text, a label or
 * a customer deal id.
 */
export async function retagOutcomes(
  deps: PipelineDeps,
  organizationId: string,
  signal: AbortSignal
): Promise<RetagResult> {
  const pending = await inTransaction(
    deps,
    organizationId,
    async (run) =>
      (await run(DEAL_LIST_PENDING_RETAG, [organizationId, '', RETAG_DEALS_PER_PASS])).rows
  )
  const result: RetagResult = { deals: 0, calls: 0, skipped: 0 }
  for (const row of pending) {
    if (signal.aborted) {
      break
    }
    const outcome = await retagDeal(deps, organizationId, String(row.id), signal)
    result.calls += outcome.calls
    result.skipped += outcome.skipped
    if (outcome.complete) {
      result.deals++
    }
  }
  if (pending.length > 0) {
    deps.logger.info('an Outcome re-tag pass ended', { organizationId, ...result })
  }
  return result
}
