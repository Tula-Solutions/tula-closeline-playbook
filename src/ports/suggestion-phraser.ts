import type { SuggestionKind } from 'tula-closeline-contract'

/** The most Moments one {@link SuggestionPhraser.propose} call takes; the caller picks the first ones. */
export const MAX_PHRASER_MOMENTS = 40

/** One Agent-origin Moment of a won Deal, as the phraser reads it. Untrusted data, never instructions. */
export type PhraserMoment = {
  /** The Prospect side of the Moment: what was said before the Agent answered. */
  prospect: string
  /** What the Agent said next (at most a few turns). */
  agentReply: string
}

/** One proposed addition: a kind, its text and the input Moments it rests on, by position in the input. */
export type ProposedSuggestion = {
  kind: SuggestionKind
  text: string
  /** Positions in the input list (0-based) of the Moments the text was derived from. */
  cited: readonly number[]
}

/** Options of one {@link SuggestionPhraser.propose} call. */
export type ProposeOptions = {
  /** Aborts the call, over and above the adapter's own timeout. */
  signal: AbortSignal
}

/**
 * Words a Suggestion from the Agent-origin Moments of a won Deal. The Moments are untrusted data (a
 * Prospect or a model said them), so an adapter never follows an instruction found in one, and the
 * caller validates every answer (kind, length, citations) as it would any model output. No vendor
 * adapter exists yet; only the memory one.
 */
export interface SuggestionPhraser {
  /**
   * Zero or more proposals for at most {@link MAX_PHRASER_MOMENTS} Moments (a `RangeError`
   * otherwise). Rejects when `options.signal` aborts. Every call has its own timeout and a bounded,
   * jittered retry inside the adapter (COMMON.md); the caller retries nothing itself.
   */
  propose(
    moments: readonly PhraserMoment[],
    options: ProposeOptions
  ): Promise<readonly ProposedSuggestion[]>
}
