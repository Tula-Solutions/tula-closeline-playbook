import {
  type CitationRef,
  documentExtension,
  PLAYBOOK_READ_ROLES,
  type ResolveCitationsRequest,
  type ResolveCitationsResponse,
  resolveCitationsResponseSchema,
} from 'tula-closeline-contract'
import {
  CALL_SEARCH_STATE,
  DOCUMENT_SEARCH_STATE,
  MAX_DOCUMENT_SEARCH_STATE_IDS,
  MAX_SEARCH_STATE_IDS,
} from 'tula-closeline-db'
import { toTextArrayLiteral } from '~/adapters/postgres/text-array'
import { momentMayBeReturned } from '~/modules/call/eligibility'
import { MOMENT_VECTOR_VERSION } from '~/modules/call/moment-vectors'
import { DOCUMENT_VECTOR_VERSION } from '~/modules/ingestion/vectors'
import { assertRole, type CallContext, transaction } from '~/modules/service-kit'
import { outside, type SearchDeps } from './service'

/** The most hits one lookup reads: the vector store's own cap on `topK`. */
const MAX_HITS = 100

type CallState = { inSearch: boolean; epoch: number; repSeq: number; dealRecordId: string }
type DocumentState = { name: string; state: string; epoch: number }

/** The snippets of one Moment, as the vector store holds them. */
type MomentText = { prospect: string; repNext: string }

/** A query vector for a lookup by attributes: the store needs one, the filter decides what matches. */
function lookupVector(dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  vector[0] = 1
  return vector
}

/** Whether a document's format has real pages: only a PDF does (as in document search). */
function hasPages(fileName: string): boolean {
  return documentExtension(fileName) === '.pdf'
}

/** The key of one document lookup: the document and the page asked for. */
const documentKey = (ref: { documentId: string; page: number | null }) =>
  `${ref.documentId}:${ref.page ?? ''}`

/** The lowest-numbered of the hits, by the number the attribute `by` carries; hits without one are ignored. */
function firstBy<T extends { attributes: Readonly<Record<string, string | number | boolean>> }>(
  hits: readonly T[],
  by: 'moment' | 'chunk'
): T | undefined {
  let best: T | undefined
  let bestNumber = Number.POSITIVE_INFINITY
  for (const hit of hits) {
    const n = hit.attributes[by]
    if (typeof n === 'number' && n < bestNumber) {
      best = hit
      bestNumber = n
    }
  }
  return best
}

/**
 * Turns Citations back into the text they point at, for the token's Organization. Every role that
 * reads the Playbook may call it.
 *
 * 1. One Postgres transaction with at most one statement per kind (`CALL_SEARCH_STATE`,
 *    `DOCUMENT_SEARCH_STATE`) over the distinct ids, at most 20. Postgres decides what is
 *    available: a Moment needs a `ready` Call of a `won` Deal that is the Deal named; a document
 *    needs to be `ready`. A reference with no row (never existed, another Organization's,
 *    deleted) is `removed`, the same as one that is not searchable yet.
 * 2. For each distinct available Moment or document passage, one vector lookup by attributes in
 *    the caller's Organization (the current build only), run together, the snippets read from the
 *    hit with the lowest Moment or chunk number. No hit means `removed`.
 * 3. One item per reference, in request order; `removed` carries the ids only.
 *
 * O(refs), at most 20: two reads and at most 20 lookups, each with the search step's deadline;
 * nothing grows with the Organization. Snippets and file names are never logged.
 */
export async function resolveCitations(
  deps: SearchDeps,
  context: CallContext,
  request: ResolveCitationsRequest
): Promise<ResolveCitationsResponse> {
  assertRole(context, PLAYBOOK_READ_ROLES)
  const { organizationId } = context
  const { refs } = request

  const callIds = [
    ...new Set(refs.flatMap((ref) => (ref.kind === 'moment' ? [ref.callId] : []))),
  ].slice(0, MAX_SEARCH_STATE_IDS)
  const documentIds = [
    ...new Set(refs.flatMap((ref) => (ref.kind === 'document' ? [ref.documentId] : []))),
  ].slice(0, MAX_DOCUMENT_SEARCH_STATE_IDS)

  const calls = new Map<string, CallState>()
  const documents = new Map<string, DocumentState>()
  if (callIds.length > 0 || documentIds.length > 0) {
    const rows = await outside(deps, 'database', organizationId, () =>
      transaction(deps, organizationId, async (run) => {
        // Postgres cancels the read itself at the step deadline; the wait covers a stall that never reaches it.
        await run(`set local statement_timeout = '${deps.env.SEARCH_STEP_TIMEOUT_MS}ms'`, [])
        const callRows =
          callIds.length === 0
            ? []
            : (await run(CALL_SEARCH_STATE, [organizationId, toTextArrayLiteral(callIds)])).rows
        const documentRows =
          documentIds.length === 0
            ? []
            : (await run(DOCUMENT_SEARCH_STATE, [organizationId, toTextArrayLiteral(documentIds)]))
                .rows
        return { callRows, documentRows }
      })
    )
    for (const row of rows.callRows) {
      calls.set(String(row.call_id), {
        inSearch: row.in_search === true,
        epoch: Number(row.epoch),
        repSeq: Number(row.rep_seq),
        dealRecordId: String(row.deal_record_id),
      })
    }
    for (const row of rows.documentRows) {
      documents.set(String(row.id), {
        name: String(row.name),
        state: String(row.state),
        epoch: Number(row.epoch),
      })
    }
  }

  // What Postgres lets through, once per distinct Call or document passage.
  const momentLookups = new Map<string, CallState>()
  const documentLookups = new Map<
    string,
    { ref: CitationRef & { kind: 'document' }; epoch: number }
  >()
  for (const ref of refs) {
    if (ref.kind === 'moment') {
      const state = calls.get(ref.callId)
      if (state?.inSearch === true && state.dealRecordId === ref.dealRecordId) {
        momentLookups.set(ref.callId, state)
      }
    } else {
      const state = documents.get(ref.documentId)
      // A page is asked for only of a file that has pages.
      if (state?.state === 'ready' && (hasPages(state.name) || ref.page === null)) {
        documentLookups.set(documentKey(ref), { ref, epoch: state.epoch })
      }
    }
  }

  const vector = lookupVector(deps.embedder.dimensions)
  const moments = new Map<string, MomentText | undefined>()
  const passages = new Map<string, string | undefined>()
  await Promise.all([
    ...[...momentLookups].map(async ([callId, state]) => {
      const hits = await outside(deps, 'vector store', organizationId, () =>
        deps.vectors.search(organizationId, {
          vector,
          topK: MAX_HITS,
          filter: {
            call_id: callId,
            epoch: state.epoch,
            rep_seq: state.repSeq,
            outcome: 'won',
            v: MOMENT_VECTOR_VERSION,
          },
        })
      )
      const hit = firstBy(
        hits.filter((candidate) => {
          const a = candidate.attributes
          return (
            typeof a.prospect === 'string' &&
            typeof a.rep_next === 'string' &&
            typeof a.outcome_seq === 'number' &&
            momentMayBeReturned(
              {
                outcome: 'won',
                outcomeSeq: a.outcome_seq,
                epoch: state.epoch,
                repSeq: state.repSeq,
              },
              state
            )
          )
        }),
        'moment'
      )
      moments.set(
        callId,
        hit === undefined
          ? undefined
          : { prospect: String(hit.attributes.prospect), repNext: String(hit.attributes.rep_next) }
      )
    }),
    ...[...documentLookups].map(async ([key, { ref, epoch }]) => {
      const hits = await outside(deps, 'vector store', organizationId, () =>
        deps.vectors.search(organizationId, {
          vector,
          topK: MAX_HITS,
          filter: {
            kind: 'document',
            document_id: ref.documentId,
            epoch,
            v: DOCUMENT_VECTOR_VERSION,
            ...(ref.page === null ? {} : { page: ref.page }),
          },
        })
      )
      const hit = firstBy(
        hits.filter((candidate) => typeof candidate.attributes.snippet === 'string'),
        'chunk'
      )
      passages.set(key, hit === undefined ? undefined : String(hit.attributes.snippet))
    }),
  ])

  return resolveCitationsResponseSchema.parse({
    items: refs.map((ref) => {
      if (ref.kind === 'moment') {
        const text = moments.get(ref.callId)
        return text === undefined
          ? { state: 'removed', kind: 'moment', callId: ref.callId, dealRecordId: ref.dealRecordId }
          : {
              state: 'available',
              kind: 'moment',
              callId: ref.callId,
              dealRecordId: ref.dealRecordId,
              prospect: text.prospect,
              repNext: text.repNext,
            }
      }
      const snippet = passages.get(documentKey(ref))
      const fileName = documents.get(ref.documentId)?.name
      return snippet === undefined || fileName === undefined
        ? { state: 'removed', kind: 'document', documentId: ref.documentId, page: ref.page }
        : {
            state: 'available',
            kind: 'document',
            documentId: ref.documentId,
            page: ref.page,
            fileName,
            snippet,
          }
    }),
  })
}
