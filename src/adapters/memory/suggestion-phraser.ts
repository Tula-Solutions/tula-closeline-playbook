import type { SuggestionKind } from 'tula-closeline-contract'
import {
  MAX_PHRASER_MOMENTS,
  type PhraserMoment,
  type ProposedSuggestion,
  type SuggestionPhraser,
} from '~/ports/suggestion-phraser'

/** A {@link SuggestionPhraser} in process memory: deterministic templates, and every call recorded. */
export type MemorySuggestionPhraser = SuggestionPhraser & {
  /** The Moments of each call, in order. */
  readonly calls: (readonly PhraserMoment[])[]
  /** Replaces the answer of every later call (a test's script); `undefined` restores the templates. */
  script(
    answer: ((moments: readonly PhraserMoment[]) => readonly ProposedSuggestion[]) | undefined
  ): void
}

/** A template's text is clipped here so it always fits a Suggestion (at most 1000 characters). */
const MAX_TEMPLATE_TEXT = 1000

const OBJECTION =
  /\b(too expensive|expensive|price|budget|not sure|concern|worried|competitor|can't|cannot)\b/i

/** The kind a Moment reads as: an objection when the Prospect pushes back, a discovery question when the Agent asks, otherwise a closing move. */
function kindOf(moment: PhraserMoment): SuggestionKind {
  if (OBJECTION.test(moment.prospect)) {
    return 'objection_answer'
  }
  return moment.agentReply.includes('?') ? 'discovery_question' : 'closing_move'
}

/** A template phrasing of one Moment; the Moment's words are quoted, never executed. */
function templateOf(moment: PhraserMoment, index: number): ProposedSuggestion {
  const kind = kindOf(moment)
  const text =
    kind === 'objection_answer'
      ? `When the Prospect says "${moment.prospect}", answer along the lines of: ${moment.agentReply}`
      : kind === 'discovery_question'
        ? `After "${moment.prospect}", ask: ${moment.agentReply}`
        : `After "${moment.prospect}", move to close: ${moment.agentReply}`
  return { kind, text: text.slice(0, MAX_TEMPLATE_TEXT), cited: [index] }
}

/** Creates the memory phraser. */
export function createMemorySuggestionPhraser(): MemorySuggestionPhraser {
  const calls: (readonly PhraserMoment[])[] = []
  let answer: ((moments: readonly PhraserMoment[]) => readonly ProposedSuggestion[]) | undefined
  return {
    calls,
    script: (next) => {
      answer = next
    },
    propose: async (moments, options) => {
      if (moments.length > MAX_PHRASER_MOMENTS) {
        throw new RangeError(`at most ${MAX_PHRASER_MOMENTS} Moments`)
      }
      options.signal.throwIfAborted()
      calls.push(moments)
      return answer === undefined ? moments.map(templateOf) : answer(moments)
    },
  }
}
