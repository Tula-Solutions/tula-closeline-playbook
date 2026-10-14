import {
  documentExtension,
  documentQueryText,
  ERRORS,
  PLAYBOOK_READ_ROLES,
  type SearchDocumentsRequest,
  type SearchDocumentsResponse,
  searchDocumentsResponseSchema,
} from 'tula-closeline-contract'
import { DOCUMENT_SEARCH_STATE, MAX_DOCUMENT_SEARCH_STATE_IDS } from 'tula-closeline-db'
import { toTextArrayLiteral } from '~/adapters/postgres/text-array'
import { RetryAfterError } from '~/http/domain-error'
import { DOCUMENT_VECTOR_VERSION } from '~/modules/ingestion/vectors'
import { assertRole, type CallContext, transaction } from '~/modules/service-kit'
import { candidatesFor, outside, SEARCH_RETRY_AFTER_SECONDS, type SearchDeps } from './service'

/** A hit read from the vector store: its attributes checked, or `undefined` for one that is not a document chunk of this layout. */
type Candidate = {
  documentId: string
  epoch: number
  page: number
  score: number
  snippet: string
}

/** Reads one hit's attributes; a hit whose attributes are not the chunk layout is dropped, never guessed at. */
function candidateOf(hit: {
  score: number
  attributes: Readonly<Record<string, string | number | boolean>>
}): Candidate | undefined {
  const a = hit.attributes
  if (
    typeof a.document_id !== 'string' ||
    typeof a.epoch !== 'number' ||
    typeof a.page !== 'number' ||
    typeof a.snippet !== 'string' ||
    a.kind !== 'document' ||
    a.v !== DOCUMENT_VECTOR_VERSION
  ) {
    return undefined
  }
  return {
    documentId: a.document_id,
    epoch: a.epoch,
    page: a.page,
    score: hit.score,
    snippet: a.snippet,
  }
}

/** Whether a file's format has real pages: only a PDF does; a text, Markdown or Word file is read as one page, so its page is `null`. */
function hasPages(fileName: string): boolean {
  return documentExtension(fileName) === '.pdf'
}

/**
 * Finds passages of the Organization's Playbook documents that resemble the conversation so far.
 * Every role that reads the Playbook may call it.
 *
 * 1. The contract's `documentQueryText` makes the text: plain, because chunks are embedded as plain text.
 * 2. One embedding (`purpose: 'query'`), then one vector search in the caller's Organization
 *    namespace for `min(100, limit x 5)` chunks of `kind: 'document'`, layout `v: 2`.
 * 3. One Postgres statement for those documents (`DOCUMENT_SEARCH_STATE`, at most 100 ids). A chunk is
 *    kept only when its document is `ready` and its epoch is the document's current epoch: a deleted,
 *    replaced or not-yet-processed document, and a document with no row (another Organization's),
 *    are dropped.
 * 4. The first `limit` survivors, best first; `evidence` counts every survivor of the window and the
 *    distinct documents among them.
 *
 * O(query length) + O(candidates) with two outside calls and one indexed read; nothing grows with the
 * Organization. The text of the query and the snippets is never logged.
 */
export async function searchDocuments(
  deps: SearchDeps,
  context: CallContext,
  request: SearchDocumentsRequest
): Promise<SearchDocumentsResponse> {
  assertRole(context, PLAYBOOK_READ_ROLES)
  const { organizationId } = context
  const text = documentQueryText(request.turns)

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
      filter: { kind: 'document', v: DOCUMENT_VECTOR_VERSION },
    })
  )
  const candidates = hits
    .map((hit) => candidateOf(hit))
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .sort((a, b) => b.score - a.score)

  const documentIds = [...new Set(candidates.map((candidate) => candidate.documentId))]
  if (documentIds.length > MAX_DOCUMENT_SEARCH_STATE_IDS) {
    // The store was asked for at most 100; more than the statement reads would be silently unread.
    throw new Error('a search found more documents than the state statement reads')
  }
  const states = new Map<string, { name: string; state: string; epoch: number }>()
  if (documentIds.length > 0) {
    const rows = await outside(deps, 'database', organizationId, () =>
      transaction(deps, organizationId, async (run) => {
        // Postgres cancels the read itself at the step deadline; the wait covers a stall that never reaches it.
        await run(`set local statement_timeout = '${deps.env.SEARCH_STEP_TIMEOUT_MS}ms'`, [])
        return (await run(DOCUMENT_SEARCH_STATE, [organizationId, toTextArrayLiteral(documentIds)]))
          .rows
      })
    )
    for (const row of rows) {
      states.set(String(row.id), {
        name: String(row.name),
        state: String(row.state),
        epoch: Number(row.epoch),
      })
    }
  }

  const eligible = candidates.flatMap((candidate) => {
    const state = states.get(candidate.documentId)
    return state !== undefined && state.state === 'ready' && state.epoch === candidate.epoch
      ? [{ candidate, fileName: state.name }]
      : []
  })
  return searchDocumentsResponseSchema.parse({
    items: eligible.slice(0, request.limit).map(({ candidate, fileName }) => ({
      documentId: candidate.documentId,
      fileName,
      page: hasPages(fileName) ? candidate.page : null,
      score: candidate.score,
      snippet: candidate.snippet,
    })),
    evidence: {
      chunks: eligible.length,
      documents: new Set(eligible.map((entry) => entry.candidate.documentId)).size,
    },
  })
}
