import {
  type AcceptSuggestionRequest,
  decodeCursor,
  encodeCursor,
  type LearningSettings,
  type ListSuggestionsQuery,
  type listSuggestionsResponseSchema,
  MAX_SUGGESTION_TEXT_LENGTH,
  SALES_HISTORY_READ_ROLES,
  type Suggestion,
  suggestionSchema,
} from 'tula-closeline-contract'
import {
  SUGGESTION_DECIDE,
  SUGGESTION_GET,
  SUGGESTION_LIST,
  SUGGESTION_LIST_BY_STATUS,
} from 'tula-closeline-db'
import type { z } from 'zod'
import type { Run } from '~/adapters/postgres/processed-store'
import { cursorPosition } from '~/modules/deal/schema'
import {
  completeKey,
  findKey,
  type KeyedRequest,
  LOCK_TIMEOUT_SQL,
  requestHashOf,
  reserveKey,
} from '~/modules/document/idempotency'
import { ensureIndexSettings } from '~/modules/ingestion/job'
import type { PipelineDeps } from '~/modules/ingestion/runtime'
import { outside } from '~/modules/search/service'
import {
  assertRole,
  type CallContext,
  failure,
  mappingBadCursor,
  transaction,
} from '~/modules/service-kit'
import {
  deciderMembershipId,
  suggestionCursorSchema,
  suggestionVectorId,
  toSuggestion,
} from './schema'
import { LEARNING_GET, LEARNING_SET } from './statements'

/** One page of Suggestions. */
type ListSuggestionsResponse = z.infer<typeof listSuggestionsResponseSchema>

/** What the Suggestion service needs from the container: the pipeline's ports, so an accepted text is indexed the way a document is. */
export type SuggestionDeps = PipelineDeps

/** The attribute `kind` of a Suggestion vector, so no search for Moments or documents can return one. */
export const SUGGESTION_VECTOR_KIND = 'suggestion'

/** The layout version of a Suggestion vector's attributes. */
export const SUGGESTION_VECTOR_VERSION = 1

/** Whether the Organization learns from Agent Moments: no settings row means the default, on. */
export async function learningIsOn(run: Run, organizationId: string): Promise<boolean> {
  const row = (await run(LEARNING_GET, [organizationId])).rows[0]
  return row === undefined || row.learn_from_agent_moments !== false
}

/** One page of the Organization's Suggestions, newest first, optionally of one status. Owner and Admin only. */
export async function list(
  deps: SuggestionDeps,
  context: CallContext,
  query: ListSuggestionsQuery
): Promise<ListSuggestionsResponse> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  let after: { createdAt: string; id: string } | undefined
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, suggestionCursorSchema)
    if (after === undefined) {
      throw failure('request.invalid')
    }
  }
  const { organizationId } = context
  const { limit } = query
  const position = [after?.createdAt ?? 'infinity', after?.id ?? ''] as const
  const rows = await mappingBadCursor(() =>
    transaction(deps, organizationId, async (run) =>
      query.status === undefined
        ? (await run(SUGGESTION_LIST, [organizationId, ...position, limit])).rows
        : (await run(SUGGESTION_LIST_BY_STATUS, [organizationId, ...position, limit, query.status]))
            .rows
    )
  )
  const last = rows.at(-1)
  return {
    items: rows.map((row) => toSuggestion(row)),
    nextCursor:
      rows.length === limit && last !== undefined ? encodeCursor(cursorPosition(last)) : null,
  }
}

/** One Suggestion of the caller's Organization; another Organization's, or an unknown one, is `suggestion.not_found`. */
export async function get(
  deps: SuggestionDeps,
  context: CallContext,
  suggestionId: string
): Promise<Suggestion> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const { organizationId } = context
  const row = await transaction(
    deps,
    organizationId,
    async (run) => (await run(SUGGESTION_GET, [organizationId, suggestionId])).rows[0]
  )
  if (row === undefined) {
    throw failure('suggestion.not_found')
  }
  return toSuggestion(row)
}

/** The edited text of an accept, trimmed, or `undefined` when none was sent; blank or too long is `request.invalid`. */
function editedTextOf(request: AcceptSuggestionRequest): string | undefined {
  if (request.text === undefined) {
    return undefined
  }
  const text = request.text.trim()
  if (text === '' || text.length > MAX_SUGGESTION_TEXT_LENGTH) {
    throw failure('request.invalid')
  }
  return text
}

/** The key record of a decision: who, which route, and what the answer depends on. */
function keyedOf(
  context: CallContext,
  key: string | undefined,
  route: string,
  request: unknown
): KeyedRequest {
  return {
    key,
    organizationId: context.organizationId,
    userId: context.userId,
    route,
    requestHash: requestHashOf(route, request),
  }
}

/** The stored answer of a replayed decision, checked as it comes back out. */
function replayed(response: unknown): Suggestion {
  return suggestionSchema.parse(response)
}

/**
 * Reads the row a decision needs to be pending, as `suggestion.not_found` (unknown) or
 * `suggestion.not_pending` (already decided) when it is not.
 */
async function assertPending(
  run: Run,
  organizationId: string,
  suggestionId: string
): Promise<void> {
  const row = (await run(SUGGESTION_GET, [organizationId, suggestionId])).rows[0]
  if (row === undefined) {
    throw failure('suggestion.not_found')
  }
  if (row.status !== 'pending') {
    throw failure('suggestion.not_pending')
  }
}

/**
 * Decides a pending Suggestion in one transaction with its idempotency key: the key first (a replay
 * answers with the stored Suggestion), then the guarded update, which only changes a pending row.
 * When nothing changed the transaction is thrown away (and the key with it) with the reason.
 */
async function decide(
  deps: SuggestionDeps,
  context: CallContext,
  suggestionId: string,
  status: 'accepted' | 'rejected',
  text: string | undefined,
  keyed: KeyedRequest
): Promise<Suggestion> {
  const { organizationId } = context
  return await transaction(deps, organizationId, async (run) => {
    await run(LOCK_TIMEOUT_SQL, [])
    const reservation = await reserveKey(run, keyed)
    if (reservation.kind === 'replay') {
      return replayed(reservation.response)
    }
    const row = (
      await run(SUGGESTION_DECIDE, [
        organizationId,
        suggestionId,
        status,
        deciderMembershipId(organizationId, context.userId),
        text ?? null,
      ])
    ).rows[0]
    if (row === undefined) {
      await assertPending(run, organizationId, suggestionId)
      throw failure('suggestion.not_pending')
    }
    const decided = toSuggestion(row)
    await completeKey(run, keyed, 200, decided)
    return decided
  })
}

/**
 * Accepts a pending Suggestion, optionally with its text edited: it then answers searches, beside
 * Moments. Owner and Admin only.
 *
 * 1. A key that already completed replays its answer; a decided or unknown Suggestion is 409 or 404.
 * 2. The final text is embedded and its vector stored (`kind: suggestion`, so no other search finds
 *    it) before the decision, so an accepted Suggestion always has a vector. A search re-reads the row
 *    from Postgres, so a vector of a Suggestion that was not accepted is never returned.
 * 3. The guarded update decides it; after a lost race the vector is removed when the row was not accepted, or stored again from the winner's text.
 *
 * O(text) with one embedding, one vector write and two short transactions.
 */
export async function accept(
  deps: SuggestionDeps,
  context: CallContext,
  suggestionId: string,
  request: AcceptSuggestionRequest,
  key: string | undefined
): Promise<Suggestion> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const { organizationId } = context
  const edited = editedTextOf(request)
  const keyed = keyedOf(context, key, 'suggestions.accept', {
    suggestionId,
    text: edited ?? null,
  })
  const early = await transaction(deps, organizationId, async (run) => {
    const found = await findKey(run, keyed)
    if (found !== undefined) {
      return { kind: 'replay' as const, suggestion: replayed(found.response) }
    }
    const row = (await run(SUGGESTION_GET, [organizationId, suggestionId])).rows[0]
    if (row === undefined) {
      throw failure('suggestion.not_found')
    }
    if (row.status !== 'pending') {
      throw failure('suggestion.not_pending')
    }
    return { kind: 'pending' as const, suggestion: toSuggestion(row) }
  })
  if (early.kind === 'replay') {
    return early.suggestion
  }

  const text = edited ?? early.suggestion.text
  const id = suggestionVectorId(suggestionId)
  await indexSuggestion(deps, organizationId, suggestionId, early.suggestion.kind, text)
  try {
    return await decide(deps, context, suggestionId, 'accepted', edited, keyed)
  } catch (error) {
    await reconcileVector(deps, organizationId, suggestionId, id, text)
    throw error
  }
}

/** Embeds a Suggestion's text and stores its vector under the fixed id of the Suggestion; idempotent. */
async function indexSuggestion(
  deps: SuggestionDeps,
  organizationId: string,
  suggestionId: string,
  kind: string,
  text: string
): Promise<void> {
  const vectors = await outside(deps, 'embedder', organizationId, (signal) =>
    deps.embedder.embed([text], { purpose: 'document', signal })
  )
  const vector = vectors[0]
  if (vectors.length !== 1 || vector === undefined || vector.length !== deps.embedder.dimensions) {
    throw new Error('the embedder answered a Suggestion with a vector of the wrong shape')
  }
  await ensureIndexSettings(deps, organizationId)
  await outside(deps, 'vector store', organizationId, () =>
    deps.vectors.upsert(organizationId, [
      {
        id: suggestionVectorId(suggestionId),
        vector,
        attributes: {
          kind: SUGGESTION_VECTOR_KIND,
          sv: SUGGESTION_VECTOR_VERSION,
          suggestion_id: suggestionId,
          suggestion_kind: kind,
        },
      },
    ])
  )
}

/**
 * After a failed accept: deletes the vector when the row was not accepted, and when a concurrent
 * accept won with another text, stores the vector of the winner's text again, so the vector always
 * matches the decided row. Best effort, never hides the first error.
 */
async function reconcileVector(
  deps: SuggestionDeps,
  organizationId: string,
  suggestionId: string,
  vectorId: string,
  indexedText: string
): Promise<void> {
  try {
    const row = await transaction(
      deps,
      organizationId,
      async (run) => (await run(SUGGESTION_GET, [organizationId, suggestionId])).rows[0]
    )
    if (row !== undefined && row.status === 'accepted') {
      const winner = toSuggestion(row)
      if (winner.text !== indexedText) {
        await indexSuggestion(deps, organizationId, suggestionId, winner.kind, winner.text)
      }
      return
    }
    await deps.vectors.delete(organizationId, [vectorId])
  } catch (error) {
    deps.logger.warn('a Suggestion vector could not be reconciled after a failed accept', {
      organizationId,
      suggestionId,
      error: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/** Rejects a pending Suggestion; it is never proposed again. Owner and Admin only. */
export async function reject(
  deps: SuggestionDeps,
  context: CallContext,
  suggestionId: string,
  key: string | undefined
): Promise<Suggestion> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const keyed = keyedOf(context, key, 'suggestions.reject', { suggestionId })
  return await decide(deps, context, suggestionId, 'rejected', undefined, keyed)
}

/** Whether the Organization's Agent Moments feed search and Suggestions. Owner and Admin only. */
export async function getLearning(
  deps: SuggestionDeps,
  context: CallContext
): Promise<LearningSettings> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const { organizationId } = context
  return {
    learnFromAgentMoments: await transaction(deps, organizationId, (run) =>
      learningIsOn(run, organizationId)
    ),
  }
}

/** Sets the switch; the end state is the answer, so a repeat changes nothing. Owner and Admin only. */
export async function setLearning(
  deps: SuggestionDeps,
  context: CallContext,
  settings: LearningSettings
): Promise<LearningSettings> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const { organizationId } = context
  const row = await transaction(
    deps,
    organizationId,
    async (run) =>
      (
        await run(LEARNING_SET, [
          organizationId,
          deps.embedder.model,
          deps.embedder.dimensions,
          settings.learnFromAgentMoments,
        ])
      ).rows[0]
  )
  return { learnFromAgentMoments: row?.learn_from_agent_moments === true }
}
