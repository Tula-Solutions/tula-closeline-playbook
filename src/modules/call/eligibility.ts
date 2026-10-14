/**
 * What a Moment's vector says about the Outcome of its Deal when it was written: the tag the
 * re-tag job rewrites. It may be stale (a Deal that went from won to lost is tagged `won` until the
 * re-tag runs), so it never decides alone.
 */
export type MomentTag = { outcome: 'won' | 'lost' | 'open'; outcomeSeq: number }

/** What Postgres says about a Call, read in the same query as its Deal's Outcome (`inSearch` of the contract's Call). */
export type CallSearchState = { inSearch: boolean }

/**
 * THE rule for whether a Moment may be returned by a search (ADR 0018: held back from search until
 * won). Both must hold: the vector's own tag says `won`, and Postgres says the Call is `inSearch`
 * (state `ready`, Deal `won`, tag current). The vector filter alone is not enough: after a Deal goes
 * from won to lost the vectors keep the `won` tag until the re-tag job runs, and Postgres is the
 * only place that already knows. The search ticket (hub issue 16) must call this for every hit, or
 * apply the same two conditions in its own query; nothing reads these vectors yet.
 */
export function momentMayBeReturned(tag: MomentTag, call: CallSearchState): boolean {
  return tag.outcome === 'won' && call.inSearch
}
