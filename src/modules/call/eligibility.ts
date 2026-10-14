/**
 * What a Moment's vector says about its Call and the Deal's Outcome when it was written: the tag
 * the re-tag job rewrites, and the epoch and Rep sequence of the build it belongs to. It may be
 * stale (a Deal that went from won to lost is tagged `won` until the re-tag runs; a Rep change
 * leaves the old build's vectors until the rebuild removes them), so it never decides alone.
 */
export type MomentTag = {
  outcome: 'won' | 'lost' | 'open'
  outcomeSeq: number
  epoch: number
  repSeq: number
}

/**
 * What Postgres says about a Call, read in one query with its Deal's Outcome (`CALL_GET`): the
 * derived `inSearch` (state `ready`, Deal `won`, tag current), and the epoch and Rep sequence the
 * Call is at now.
 */
export type CallSearchState = { inSearch: boolean; epoch: number; repSeq: number }

/**
 * THE rule for whether a Moment may be returned by a search (ADR 0018: held back from search until
 * won). All must hold: the vector's own tag says `won`, Postgres says the Call is `inSearch`, and
 * the vector belongs to the Call's current build (same epoch and Rep sequence), so a vector an
 * earlier Rep or a deleted-and-restored Call left behind is never returned. The vector filter
 * alone is not enough: after a Deal goes from won to lost the vectors keep the `won` tag until the
 * re-tag job runs, and Postgres is the only place that already knows. The search ticket (hub issue
 * 16) must call this for every hit, or apply the same conditions in its own query; no search route
 * exists yet.
 */
export function momentMayBeReturned(tag: MomentTag, call: CallSearchState): boolean {
  return (
    tag.outcome === 'won' && call.inSearch && tag.epoch === call.epoch && tag.repSeq === call.repSeq
  )
}
