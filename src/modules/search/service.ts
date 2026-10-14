import {
  ERRORS,
  MAX_SEARCH_CANDIDATES,
  momentQueryText,
  SALES_HISTORY_READ_ROLES,
  type SearchMomentsRequest,
  type SearchMomentsResponse,
  searchMomentsResponseSchema,
} from 'tula-closeline-contract'
import { CALL_SEARCH_STATE, MAX_SEARCH_STATE_IDS } from 'tula-closeline-db'
import { toTextArrayLiteral } from '~/adapters/postgres/text-array'
import type { Container } from '~/container'
import { RetryAfterError } from '~/http/domain-error'
import { type MomentTag, momentMayBeReturned } from '~/modules/call/eligibility'
import { MOMENT_VECTOR_VERSION } from '~/modules/call/moment-vectors'
import { CallTimeout, within } from '~/modules/ingestion/runtime'
import { assertRole, type CallContext, failure, transaction } from '~/modules/service-kit'

/** What a search needs from the container. */
export type SearchDeps = Pick<
  Container,
  'scope' | 'vectors' | 'embedder' | 'logger' | 'env' | 'sleep'
>

/** The seconds a 503 from a search asks the caller to wait. */
export const SEARCH_RETRY_AFTER_SECONDS = 1

/** How many candidates a request of `limit` asks the vector store for: five times the limit, at most the contract's window. */
export function candidatesFor(limit: number): number {
  return Math.min(MAX_SEARCH_CANDIDATES, limit * 5)
}

/** A hit read from the vector store: its attributes checked, or `undefined` for one that is not a Moment of this layout. */
type Candidate = {
  callId: string
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
    score: hit.score,
    tag: { outcome: a.outcome, outcomeSeq: a.outcome_seq, epoch: a.epoch, repSeq: a.rep_seq },
    prospect: a.prospect,
    repNext: a.rep_next,
  }
}

/** Runs one outside call with the search's deadline; a deadline is a 504, any other failure a 503 with Retry-After. The text is never in the log. */
async function outside<T>(
  deps: SearchDeps,
  label: string,
  organizationId: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  try {
    return await within(
      deps,
      label,
      deps.env.SEARCH_STEP_TIMEOUT_MS,
      new AbortController().signal,
      fn
    )
  } catch (error) {
    if (error instanceof CallTimeout) {
      throw failure('server.timeout')
    }
    deps.logger.warn('a search could not be answered by the model or the store', {
      organizationId,
      step: label,
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

  const hits = await outside(deps, 'vector store', organizationId, () =>
    deps.vectors.search(organizationId, {
      vector: query,
      topK: candidatesFor(request.limit),
      filter: { outcome: 'won', v: MOMENT_VECTOR_VERSION },
    })
  )
  const candidates = hits
    .map((hit) => candidateOf(hit))
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .sort((a, b) => b.score - a.score)

  const callIds = [...new Set(candidates.map((candidate) => candidate.callId))]
  if (callIds.length > MAX_SEARCH_STATE_IDS) {
    // The store was asked for at most 100; more than the statement reads would be silently unread.
    throw new Error('a search found more Calls than the state statement reads')
  }
  const states = new Map<
    string,
    { inSearch: boolean; epoch: number; repSeq: number; dealRecordId: string }
  >()
  if (callIds.length > 0) {
    const rows = await transaction(
      deps,
      organizationId,
      async (run) =>
        (await run(CALL_SEARCH_STATE, [organizationId, toTextArrayLiteral(callIds)])).rows
    )
    for (const row of rows) {
      states.set(String(row.call_id), {
        inSearch: row.in_search === true,
        epoch: Number(row.epoch),
        repSeq: Number(row.rep_seq),
        dealRecordId: String(row.deal_record_id),
      })
    }
  }

  const eligible = candidates.flatMap((candidate) => {
    const state = states.get(candidate.callId)
    return state !== undefined && momentMayBeReturned(candidate.tag, state)
      ? [{ candidate, dealRecordId: state.dealRecordId }]
      : []
  })
  return searchMomentsResponseSchema.parse({
    items: eligible.slice(0, request.limit).map(({ candidate, dealRecordId }) => ({
      callId: candidate.callId,
      dealRecordId,
      score: candidate.score,
      prospect: candidate.prospect,
      repNext: candidate.repNext,
    })),
    evidence: {
      moments: eligible.length,
      deals: new Set(eligible.map((entry) => entry.dealRecordId)).size,
    },
  })
}
