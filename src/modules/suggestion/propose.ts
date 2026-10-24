import { randomUUID } from 'node:crypto'
import {
  formatId,
  MAX_SUGGESTION_MOMENTS,
  MAX_SUGGESTION_TEXT_LENGTH,
  SUGGESTION_KINDS,
} from 'tula-closeline-contract'
import { CALL_LIST_BY_DEAL_STATE, DEAL_GET, SUGGESTION_INSERT } from 'tula-closeline-db'
import { recordingTranscriptKey, repLabelOf } from '~/modules/call/keys'
import { buildMoments, capMoments } from '~/modules/call/moments'
import { callOriginOf } from '~/modules/call/origin'
import { objectKeyOf } from '~/modules/call/retag'
import { parseTranscript, type TranscriptMediaType } from '~/modules/call/transcript'
import { inTransaction, type PipelineDeps, within } from '~/modules/ingestion/runtime'
import { attributeSnippet } from '~/modules/ingestion/snippet'
import {
  MAX_PHRASER_MOMENTS,
  type PhraserMoment,
  type ProposedSuggestion,
} from '~/ports/suggestion-phraser'
import { fingerprintOf } from './schema'
import { LEARNING_GET } from './statements'

/** The Agent Calls of a won Deal one proposal reads: a bounded page, never the Deal's whole history. */
export const PROPOSAL_CALLS = 20

/** The rows of one page the proposal reads while it looks for Agent Calls. */
const PROPOSAL_PAGE_SIZE = 20

/** The most pages the proposal reads for a Deal, so the look is bounded however long the history is. */
const MAX_PROPOSAL_PAGES = 5

/** How one proposal run ended, for the log and the tests. */
export type ProposalResult = { proposed: number; skipped: string | null }

/** A Moment the phraser was shown, remembered with the Call it came from. */
type Source = { callId: string; momentIndex: number }

/** One proposal of the model, checked: a known kind, trimmed text of 1 to 1000 characters, and valid distinct citations. */
function checked(
  proposal: ProposedSuggestion,
  sources: readonly Source[]
): { kind: string; text: string; cited: Source[] } | undefined {
  const text = typeof proposal.text === 'string' ? proposal.text.trim() : ''
  if (
    !(SUGGESTION_KINDS as readonly string[]).includes(proposal.kind) ||
    text === '' ||
    text.length > MAX_SUGGESTION_TEXT_LENGTH ||
    !Array.isArray(proposal.cited) ||
    proposal.cited.length > MAX_PHRASER_MOMENTS
  ) {
    return undefined
  }
  const cited: Source[] = []
  for (const at of new Set(proposal.cited)) {
    const source = Number.isInteger(at) ? sources[at] : undefined
    if (source === undefined) {
      return undefined
    }
    cited.push(source)
  }
  if (cited.length === 0) {
    return undefined
  }
  return { kind: proposal.kind, text, cited: cited.slice(0, MAX_SUGGESTION_MOMENTS) }
}

/**
 * Proposes Suggestions from the Agent Calls of a Deal that is won. Nothing happens when the Deal is
 * not won, the Organization's learning switch is off, or the Deal has no ready Agent Call. The
 * Moments of at most {@link PROPOSAL_CALLS} Calls (capped at {@link MAX_PHRASER_MOMENTS} in all) go
 * to the phraser; each answer is validated as model output (kind, length, citations) and stored
 * pending with its provenance. The fingerprint of kind and text makes it idempotent: the same advice
 * is never stored twice, and one an Admin rejected is never proposed again.
 *
 * O(Calls read x Moments) with a fixed ceiling; one model call. Moment text is never logged.
 */
export async function proposeFromWonDeal(
  deps: PipelineDeps,
  organizationId: string,
  dealRecordId: string,
  signal: AbortSignal
): Promise<ProposalResult> {
  const timeout = deps.env.INGESTION_IO_TIMEOUT_MS
  const found: { skipped: string } | { calls: Record<string, unknown>[] } = await inTransaction(
    deps,
    organizationId,
    async (run) => {
      const deal = (await run(DEAL_GET, [organizationId, dealRecordId])).rows[0]
      if (deal === undefined || deal.outcome !== 'won') {
        return { skipped: 'not won' as const }
      }
      const learning = (await run(LEARNING_GET, [organizationId])).rows[0]
      if (learning !== undefined && learning.learn_from_agent_moments === false) {
        return { skipped: 'learning off' as const }
      }
      // Newest first, a bounded number of pages: Agent Calls are found even behind newer Calls of
      // another origin, and a Deal with a long history is never read whole.
      const calls: Record<string, unknown>[] = []
      let createdAt = 'infinity'
      let after = ''
      for (let page = 0; page < MAX_PROPOSAL_PAGES && calls.length < PROPOSAL_CALLS; page++) {
        const rows = (
          await run(CALL_LIST_BY_DEAL_STATE, [
            organizationId,
            createdAt,
            after,
            PROPOSAL_PAGE_SIZE,
            dealRecordId,
            'ready',
          ])
        ).rows
        for (const row of rows) {
          if (callOriginOf(row) === 'agent' && calls.length < PROPOSAL_CALLS) {
            calls.push(row)
          }
        }
        const last = rows.at(-1)
        if (rows.length < PROPOSAL_PAGE_SIZE || last === undefined) {
          break
        }
        createdAt = String(last.cursor_at)
        after = String(last.id)
      }
      return { calls }
    }
  )
  if ('skipped' in found) {
    return { proposed: 0, skipped: found.skipped }
  }

  const shown: PhraserMoment[] = []
  const sources: Source[] = []
  for (const call of found.calls) {
    signal.throwIfAborted()
    const callId = String(call.id)
    const recording = call.kind === 'recording'
    const repLabel = repLabelOf(call)
    const key = recording
      ? recordingTranscriptKey(callId)
      : objectKeyOf(callId, String(call.media_type))
    if ((!recording && call.kind !== 'transcript') || repLabel === null || key === undefined) {
      continue
    }
    const object = await within(deps, 'object store', timeout, signal, () =>
      deps.objects.get(organizationId, key)
    )
    if (object === undefined) {
      continue
    }
    const parsed = parseTranscript(
      object.body,
      recording ? 'application/json' : (call.media_type as TranscriptMediaType)
    )
    if (!parsed.ok) {
      continue
    }
    const moments = capMoments(
      buildMoments(parsed.transcript.turns, repLabel),
      deps.env.MAX_MOMENTS_PER_CALL
    )
    for (const moment of moments) {
      if (shown.length >= MAX_PHRASER_MOMENTS) {
        break
      }
      shown.push({
        prospect: attributeSnippet(moment.context.at(-1)?.text ?? ''),
        agentReply: attributeSnippet(moment.repFollowing.join(' ')),
      })
      sources.push({ callId, momentIndex: moment.index })
    }
  }
  if (shown.length === 0) {
    return { proposed: 0, skipped: 'no moments' }
  }

  const proposals = await within(deps, 'suggestion phraser', timeout, signal, (inner) =>
    deps.phraser.propose(shown, { signal: inner })
  )
  let proposed = 0
  // The answer is model output: no more proposals than the phraser may be shown Moments, whatever it returned.
  for (const proposal of proposals.slice(0, MAX_PHRASER_MOMENTS)) {
    const valid = checked(proposal, sources)
    if (valid === undefined) {
      deps.logger.warn('the phraser proposed a Suggestion that failed validation; it is dropped', {
        organizationId,
        dealRecordId,
      })
      continue
    }
    const moments = valid.cited.map((source) => ({
      kind: 'moment',
      callId: source.callId,
      dealRecordId,
      momentIndex: source.momentIndex,
    }))
    const inserted = await inTransaction(deps, organizationId, async (run) => {
      const learning = (await run(LEARNING_GET, [organizationId])).rows[0]
      if (learning !== undefined && learning.learn_from_agent_moments === false) {
        return false
      }
      return (
        (
          await run(SUGGESTION_INSERT, [
            organizationId,
            formatId('sgs', randomUUID()),
            valid.kind,
            valid.text,
            fingerprintOf(valid.kind, valid.text),
            dealRecordId,
            JSON.stringify(moments),
          ])
        ).rows.length > 0
      )
    })
    if (inserted) {
      proposed++
    }
  }
  return { proposed, skipped: null }
}
