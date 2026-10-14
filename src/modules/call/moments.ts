import {
  MAX_REP_FOLLOWING_CHARACTERS,
  MAX_REP_FOLLOWING_TURNS,
  momentQueryText,
} from 'tula-closeline-contract'
import type { Turn } from './transcript'

/**
 * The most turns in a Moment's context, the Prospect's turn included. The contract leaves this open
 * (ADR 0018); this is the ticket's default and the owner may change it.
 */
export const MOMENT_CONTEXT_TURNS = 6

/** The most characters (Unicode code points) of a Moment's context, the Prospect's turn included; the oldest turns go first. The ticket's default. */
export const MOMENT_CONTEXT_CHARACTERS = 2000

/** The side a turn is on: the chosen Rep, or anyone else (the Prospect's side). Labels never reach a Moment. */
export type Role = 'rep' | 'prospect'

/** One turn of a Moment's context, by role. */
export type ContextTurn = { role: Role; text: string }

/**
 * A Moment (ADR 0018): a window of turns ending on a Prospect turn, with the Rep's next turns kept
 * beside it. `index` is its number among the Call's Moments (the vector id is made from it), `turn`
 * the position of its Prospect turn in the Transcript, and `text` what is embedded: the context
 * only, by role, never the Rep's reply or a speaker label.
 */
export type Moment = {
  index: number
  turn: number
  context: ContextTurn[]
  repFollowing: string[]
  text: string
}

/** The first `max` code points of `text`; a string within `max` UTF-16 units is returned as it is. */
function codePoints(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  let end = 0
  let count = 0
  for (const point of text) {
    if (count === max) {
      break
    }
    end += point.length
    count++
  }
  return text.slice(0, end)
}

/** The number of code points in `text`. */
function lengthOf(text: string): number {
  if (text.length <= 1) {
    return text.length
  }
  let count = 0
  for (const _ of text) {
    count++
  }
  return count
}

/**
 * Builds the Moments of a Transcript: one per turn whose speaker is not `repLabel`. Its context is
 * the turns up to and including that one, at most {@link MOMENT_CONTEXT_TURNS} and
 * {@link MOMENT_CONTEXT_CHARACTERS} code points (the oldest are dropped first, and a Prospect turn
 * longer than the limit is cut); the Rep's turns that follow it directly, at most
 * {@link MAX_REP_FOLLOWING_TURNS} and {@link MAX_REP_FOLLOWING_CHARACTERS} code points, are kept
 * beside it. O(turns) time with a window of constant size; the result holds at most one Moment per
 * turn.
 */
export function buildMoments(turns: readonly Turn[], repLabel: string): Moment[] {
  const moments: Moment[] = []
  const lengths = turns.map((turn) => lengthOf(turn.text))
  for (let at = 0; at < turns.length; at++) {
    const turn = turns[at]
    if (turn === undefined || turn.speaker === repLabel) {
      continue
    }
    let from = Math.max(0, at - (MOMENT_CONTEXT_TURNS - 1))
    let total = 0
    for (let k = from; k <= at; k++) {
      total += lengths[k] ?? 0
    }
    while (from < at && total > MOMENT_CONTEXT_CHARACTERS) {
      total -= lengths[from] ?? 0
      from++
    }
    const context: ContextTurn[] = []
    for (let k = from; k <= at; k++) {
      const entry = turns[k]
      if (entry !== undefined) {
        context.push({
          role: entry.speaker === repLabel ? 'rep' : 'prospect',
          text: k === at ? codePoints(entry.text, MOMENT_CONTEXT_CHARACTERS) : entry.text,
        })
      }
    }
    const repFollowing: string[] = []
    let left = MAX_REP_FOLLOWING_CHARACTERS
    for (let k = at + 1; k < turns.length && repFollowing.length < MAX_REP_FOLLOWING_TURNS; k++) {
      const next = turns[k]
      if (next === undefined || next.speaker !== repLabel || left <= 0) {
        break
      }
      const kept = codePoints(next.text, left)
      repFollowing.push(kept)
      left -= lengthOf(kept)
    }
    moments.push({
      index: moments.length,
      turn: at,
      context,
      repFollowing,
      // The contract's function, which search also calls, so indexed text and query text are identical.
      text: momentQueryText(context),
    })
  }
  return moments
}
