import {
  ERRORS,
  MAX_SEARCH_CANDIDATES,
  momentQueryText,
  SALES_HISTORY_READ_ROLES,
  type SearchMomentsRequest,
  type SearchMomentsResponse,
  searchMomentsResponseSchema,
} from 'tula-closeline-contract'
import { CALL_SEARCH_STATE, MAX_SEARCH_STATE_IDS, SUGGESTION_GET } from 'tula-closeline-db'
import { VECTOR_ERROR_CODES, VectorError } from 'tula-closeline-kit'
import { postgresErrorOf } from '~/adapters/postgres/retry'
import { toTextArrayLiteral } from '~/adapters/postgres/text-array'
import type { Container } from '~/container'
import { RetryAfterError } from '~/http/domain-error'
import { type MomentTag, momentMayBeReturned } from '~/modules/call/eligibility'
import { MOMENT_VECTOR_VERSION } from '~/modules/call/moment-vectors'
import { type CallOrigin, callOriginOf } from '~/modules/call/origin'
import { CallTimeout, within } from '~/modules/ingestion/runtime'
import {
  assertRole,
  type CallContext,
  failure,
  isTransientFailure,
  transaction,
} from '~/modules/service-kit'
import { momentRefsOf, toSuggestion } from '~/modules/suggestion/schema'
import {
  learningIsOn,
  SUGGESTION_VECTOR_KIND,
  SUGGESTION_VECTOR_VERSION,
} from '~/modules/suggestion/service'

/** What a search needs from the container. */
export type SearchDeps = Pick<
  Container,
  'scope' | 'vectors' | 'embedder' | 'logger' | 'env' | 'sleep' | 'random'
>

/** The most accepted Suggestions a search returns (the contract's window). */
const MAX_SEARCH_SUGGESTIONS = 20

/** What an Agent Moment's score is multiplied by: it counts for half beside a Rep's or imported one. */
const AGENT_WEIGHT = 0.5

/** Agent Moments fill at most one place in this many of a request's `limit` (rounded up): two of ten. */
const AGENT_SHARE_DENOMINATOR = 5

/** The SQLSTATE of a statement Postgres cancelled at its `statement_timeout`. */
const QUERY_CANCELED = '57014'

/** The seconds a 503 from a search asks the caller to wait. */
export const SEARCH_RETRY_AFTER_SECONDS = 1

/** How many candidates a request of `limit` asks the vector store for: five times the limit, at most the contract's window. */
export function candidatesFor(limit: number): number {
  return Math.min(MAX_SEARCH_CANDIDATES, limit * 5)
}

/** A hit read from the vector store: its attributes checked, or `undefined` for one that is not a Moment of this layout. */
type Candidate = {
  callId: string
  momentIndex?: number
  score: number
  tag: MomentTag
  prospect: string
  repNext: string
}

/** Reads one hit's attributes; a hit whose attributes are not the Moment layout is dropped, never guessed at. */
function candidateOf(hit: {
  score: number
  attributes: Readonly<Record<string, string | number | boolean>>
}): Candidate | undefined {
  const a = hit.attributes
  if (
    typeof a.call_id !== 'string' ||
    typeof a.outcome !== 'string' ||
    (a.outcome !== 'won' && a.outcome !== 'lost' && a.outcome !== 'open') ||
    typeof a.outcome_seq !== 'number' ||
    typeof a.epoch !== 'number' ||
    typeof a.rep_seq !== 'number' ||
    typeof a.prospect !== 'string' ||
    typeof a.rep_next !== 'string' ||
    a.v !== MOMENT_VECTOR_VERSION
  ) {
    return undefined
  }
  return {
    callId: a.call_id,
    ...(Number.isInteger(a.moment) ? { momentIndex: Number(a.moment) } : {}),
    score: hit.score,
    tag: { outcome: a.outcome, outcomeSeq: a.outcome_seq, epoch: a.epoch, repSeq: a.rep_seq },
    prospect: a.prospect,
    repNext: a.rep_next,
  }
}

/** The most a retry waits before its second attempt, in milliseconds (a random part of it). */
const RETRY_JITTER_MS = 100

/** What a step does with a failure: the kind of step and how its failures are classed. */
export type Step = 'embedder' | 'vector store' | 'database'

/**
 * Whether a failure of the step cannot be cured by a repeat and is ours to fix, so it is a 500 and
 * is reported rather than a 503: a store refusing the request, an embedder given input it rejects
 * (the port's documented `RangeError`; a transport `TypeError` such as `fetch failed` stays a 503) and a database
 * error that is not a lost connection.
 */
function isPermanentFailure(step: Step, error: unknown): boolean {
  if (step === 'database') {
    return !isTransientFailure(error)
  }
  if (error instanceof VectorError) {
    return (
      error.code !== VECTOR_ERROR_CODES.unavailable && error.code !== VECTOR_ERROR_CODES.badResponse
    )
  }
  return error instanceof RangeError
}

/**
 * Runs one outside call with the search's deadline. A deadline is a 504; a failure a repeat cannot
 * cure is rethrown (a 500); any other is a 503 with Retry-After. The vector store gets one jittered
 * retry inside the same deadline: kit's store does not retry itself. The embedder gets none here
 * because its port requires the adapter to retry inside the call (`src/ports/embedder.ts`), and a
 * database read is not repeated (its transaction helper already retries serialization failures).
 * The text is never in the log.
 */
export async function outside<T>(
  deps: SearchDeps,
  step: Step,
  organizationId: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const attempt = async (signal: AbortSignal): Promise<T> => {
    try {
      return await fn(signal)
    } catch (error) {
      if (step !== 'vector store' || isPermanentFailure(step, error) || signal.aborted) {
        throw error
      }
      const delay = Math.floor(deps.random() * RETRY_JITTER_MS)
      if (delay > 0) {
        await deps.sleep(delay, signal)
      }
      return await fn(signal)
    }
  }
  try {
    return await within(
      deps,
      step,
      deps.env.SEARCH_STEP_TIMEOUT_MS,
      new AbortController().signal,
      attempt
    )
  } catch (error) {
    if (error instanceof CallTimeout || postgresErrorOf(error)?.code === QUERY_CANCELED) {
      throw failure('server.timeout')
    }
    if (isPermanentFailure(step, error)) {
      // A store's own 4xx must not reach the caller as that status: our request to it was wrong, so it is a 500.
      throw error instanceof VectorError
        ? new Error(`the ${step} refused a search request (${error.code})`, { cause: error })
        : error
    }
    deps.logger.warn('a search could not be answered by the model or the store', {
      organizationId,
      step,
      error: error instanceof Error ? error.name : 'unknown',
    })
    throw new RetryAfterError(ERRORS['server.unavailable'], SEARCH_RETRY_AFTER_SECONDS)
  }
}

/**
 * Finds Moments of won Deals that resemble the conversation so far. Owner and Admin only.
 *
 * 1. The contract's `momentQueryText` makes the text, so it is the indexer's own format; a turn of
 *    whitespace only is `request.invalid`.
 * 2. One embedding (`purpose: 'query'`), then one vector search in the caller's Organization
 *    namespace for `min(100, limit x 5)` candidates tagged `won` with the snippet layout (`v: 2`).
 * 3. One Postgres statement for those Calls (`CALL_SEARCH_STATE`, at most 100 ids), and every
 *    candidate must pass `momentMayBeReturned`: Postgres decides, the vector's tag is a hint. A
 *    candidate with no row (another Organization's Call, a deleted one) is dropped.
 * 4. The first `limit` survivors, best first; `evidence` counts every survivor of the window and
 *    the distinct Deals among them.
 *
 * O(query length) + O(candidates) with two outside calls and one indexed read; nothing grows with the
 * Organization. The text of the query, the Moments and the snippets is never logged.
 */
export async function searchMoments(
  deps: SearchDeps,
  context: CallContext,
  request: SearchMomentsRequest
): Promise<SearchMomentsResponse> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const { organizationId } = context
  if (request.turns.some((turn) => turn.text.trim() === '')) {
    throw failure('request.invalid')
  }
  const text = momentQueryText(request.turns)

  const vectors = await outside(deps, 'embedder', organizationId, (signal) =>
    deps.embedder.embed([text], { purpose: 'query', signal })
  )
  const query = vectors[0]
  if (vectors.length !== 1 || query === undefined || query.length !== deps.embedder.dimensions) {
    deps.logger.warn('the embedder answered a search with a vector of the wrong shape', {
      organizationId,
    })
    throw new RetryAfterError(ERRORS['server.unavailable'], SEARCH_RETRY_AFTER_SECONDS)
  }

  const [hits, suggestionHits] = await Promise.all([
    outside(deps, 'vector store', organizationId, () =>
      deps.vectors.search(organizationId, {
        vector: query,
        topK: candidatesFor(request.limit),
        filter: { outcome: 'won', v: MOMENT_VECTOR_VERSION },
      })
    ),
    // Suggestions are an addition to the answer: when their lookup fails the Moments still come back.
    outside(deps, 'vector store', organizationId, () =>
      deps.vectors.search(organizationId, {
        vector: query,
        topK: MAX_SEARCH_SUGGESTIONS,
        filter: { kind: SUGGESTION_VECTOR_KIND, sv: SUGGESTION_VECTOR_VERSION },
      })
    ).catch((error: unknown) => {
      deps.logger.warn('the Suggestion lookup failed; the search answers without Suggestions', {
        organizationId,
        reason: error instanceof Error ? error.name : 'unknown',
      })
      return []
    }),
  ])
  const candidates = hits
    .map((hit) => candidateOf(hit))
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .sort((a, b) => b.score - a.score)

  const callIds = [...new Set(candidates.map((candidate) => candidate.callId))]
  if (callIds.length > MAX_SEARCH_STATE_IDS) {
    // The store was asked for at most 100; more than the statement reads would be silently unread.
    throw new Error('a search found more Calls than the state statement reads')
  }
  const suggestionIds = [
    ...new Set(
      suggestionHits.flatMap((hit) =>
        typeof hit.attributes.suggestion_id === 'string' ? [hit.attributes.suggestion_id] : []
      )
    ),
  ]
  const states = new Map<
    string,
    { inSearch: boolean; epoch: number; repSeq: number; dealRecordId: string; origin: CallOrigin }
  >()
  const accepted = new Map<string, Record<string, unknown>>()
  // One read of Postgres decides everything the store only hints at: the Calls' state, the switch
  // and which Suggestions are accepted.
  const read = await outside(deps, 'database', organizationId, () =>
    transaction(deps, organizationId, async (run) => {
      // Postgres cancels the read itself at the step deadline; the wait above covers a stall that never reaches it.
      await run(`set local statement_timeout = '${deps.env.SEARCH_STEP_TIMEOUT_MS}ms'`, [])
      const learning = await learningIsOn(run, organizationId)
      const stateRows =
        callIds.length === 0
          ? []
          : (await run(CALL_SEARCH_STATE, [organizationId, toTextArrayLiteral(callIds)])).rows
      const suggestionRows: Record<string, unknown>[] = []
      const citedLive = new Set<string>()
      if (learning) {
        for (const id of suggestionIds) {
          const row = (await run(SUGGESTION_GET, [organizationId, id])).rows[0]
          if (row !== undefined && row.status === 'accepted') {
            suggestionRows.push(row)
          }
        }
        // An accepted Suggestion is only as good as the Calls it cites: it is returned while at
        // least one of them can still be searched (not deleted, rights kept, Deal still won).
        const cited = [
          ...new Set(suggestionRows.flatMap((row) => momentRefsOf(row).map((ref) => ref.callId))),
        ].slice(0, MAX_SEARCH_STATE_IDS)
        if (cited.length > 0) {
          const live = (await run(CALL_SEARCH_STATE, [organizationId, toTextArrayLiteral(cited)]))
            .rows
          for (const row of live) {
            if (row.in_search === true) {
              citedLive.add(String(row.call_id))
            }
          }
        }
      }
      return { learning, stateRows, suggestionRows, citedLive }
    })
  )
  for (const row of read.stateRows) {
    states.set(String(row.call_id), {
      inSearch: row.in_search === true,
      epoch: Number(row.epoch),
      repSeq: Number(row.rep_seq),
      dealRecordId: String(row.deal_record_id),
      origin: callOriginOf(row),
    })
  }
  for (const row of read.suggestionRows) {
    if (momentRefsOf(row).some((ref) => read.citedLive.has(ref.callId))) {
      accepted.set(String(row.id), row)
    }
  }

  const eligible = candidates
    .flatMap((candidate) => {
      const state = states.get(candidate.callId)
      if (state === undefined || !momentMayBeReturned(candidate.tag, state)) {
        return []
      }
      // With the switch off an Agent Moment is as if it did not exist.
      if (state.origin === 'agent' && !read.learning) {
        return []
      }
      const score = state.origin === 'agent' ? candidate.score * AGENT_WEIGHT : candidate.score
      return [{ candidate, dealRecordId: state.dealRecordId, origin: state.origin, score }]
    })
    .sort((a, b) => b.score - a.score)
  const agentCap = Math.ceil(request.limit / AGENT_SHARE_DENOMINATOR)
  const items: typeof eligible = []
  let agents = 0
  for (const entry of eligible) {
    if (items.length >= request.limit) {
      break
    }
    if (entry.origin === 'agent') {
      if (agents >= agentCap) {
        continue
      }
      agents++
    }
    items.push(entry)
  }
  const suggestions = suggestionHits.flatMap((hit) => {
    const row = accepted.get(String(hit.attributes.suggestion_id))
    if (row === undefined) {
      return []
    }
    const suggestion = toSuggestion(row)
    return [
      {
        suggestionId: suggestion.id,
        kind: suggestion.kind,
        text: suggestion.text,
        score: hit.score,
        provenance: {
          dealRecordId: suggestion.provenance.dealRecordId,
          momentRefs: momentRefsOf(row),
        },
      },
    ]
  })
  return searchMomentsResponseSchema.parse({
    items: items.map(({ candidate, dealRecordId, origin, score }) => ({
      callId: candidate.callId,
      dealRecordId,
      ...(candidate.momentIndex === undefined ? {} : { momentIndex: candidate.momentIndex }),
      score,
      origin,
      prospect: candidate.prospect,
      repNext: candidate.repNext,
    })),
    suggestions: suggestions.slice(0, Math.min(request.limit, MAX_SEARCH_SUGGESTIONS)),
    evidence: {
      moments: eligible.length,
      deals: new Set(eligible.map((entry) => entry.dealRecordId)).size,
    },
  })
}
