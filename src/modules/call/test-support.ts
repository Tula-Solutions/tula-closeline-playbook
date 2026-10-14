import { type Call, callSchema, listCallsResponseSchema } from 'tula-closeline-contract'
import { CALL_GET } from 'tula-closeline-db'
import { createDocumentHarness, type DocumentHarness } from '~/modules/document/test-support'
import type { TestDepsOverrides, TestIdentity } from '~/testing'
import { type MomentTag, momentMayBeReturned } from './eligibility'

/** The Call routes, relative to the app. */
export const CALLS = '/v1/playbook/calls'

/** A small plain-text Transcript with a Rep ("Alex") and a Prospect ("Sam"); `seed` makes the bytes differ. */
export function transcriptText(seed = 'one', turns = 3): string {
  const lines: string[] = []
  for (let i = 0; i < turns; i++) {
    lines.push(`Alex: Hello ${seed}, this is the Rep speaking, turn ${i}.`)
    lines.push(`Sam: I have a question about pricing, round ${i}.`)
  }
  return `${lines.join('\n')}\n`
}

/** A harness for the Call routes and job over the database double. */
export type CallHarness = DocumentHarness & {
  /** A request to a Call route as `identity` (an Owner by default). */
  send(
    method: string,
    path: string,
    options?: { as?: TestIdentity | null; body?: unknown }
  ): Promise<Response>
  /** Uploads a Transcript as `identity` (an Owner by default). */
  uploadCall(
    text: string | Uint8Array,
    options?: {
      name?: string
      type?: string
      dealId?: string | null
      rep?: string | null
      as?: TestIdentity | null
      key?: string
      headers?: Record<string, string>
      extra?: Record<string, string>
    }
  ): Promise<Response>
  /** Confirms rights for the harness Organization at the current wording version. */
  confirmRights(organizationId?: string): void
  /** Runs the job loop's passes (without the Outcome re-tag) until no Call job is claimed; returns the jobs run. */
  runCalls(): Promise<number>
  /** The Moment vectors of a Call, and which of them `momentMayBeReturned` lets a search return, from real state. */
  moments(callId: string): Promise<{ total: number; returnable: number; outcomes: string[] }>
  /** Sets a Deal's Outcome through the route as an Owner; returns the new sequence. */
  setOutcome(dealRecordId: string, outcome: 'won' | 'lost' | 'open'): Promise<number>
  /** One Call read through the route. */
  readCall(callId: string, as?: TestIdentity): Promise<Call>
  /** Every Call of the Organization, read through the list route. */
  listAll(query?: string): Promise<Call[]>
}

/** Builds the app over the database double with the Call job enabled and rights confirmed. */
export async function createCallHarness(overrides: TestDepsOverrides = {}): Promise<CallHarness> {
  const h = await createDocumentHarness({
    ...overrides,
    env: { WORKERS_ENABLED: 'true', ...overrides.env },
  })
  const confirmRights: CallHarness['confirmRights'] = (organizationId = h.organizationId) => {
    h.deps.database.seedRights({
      organization_id: organizationId,
      confirmed_by: h.people.owner.userId,
      confirmed_at: 0,
      wording_version: h.deps.env.RIGHTS_WORDING_VERSION,
    })
  }
  confirmRights()
  const send: CallHarness['send'] = async (method, path, options = {}) => {
    const auth = options.as === null ? {} : await h.bearer(options.as ?? h.people.owner)
    return h.app.request(path, {
      method,
      headers: {
        ...auth,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }
  const uploadCall: CallHarness['uploadCall'] = async (text, options = {}) => {
    const auth = options.as === null ? {} : await h.bearer(options.as ?? h.people.owner)
    const form = new FormData()
    form.append(
      'file',
      new File([text], options.name ?? 'call.txt', { type: options.type ?? 'text/plain' })
    )
    if (options.dealId !== null) {
      form.append('dealId', options.dealId ?? 'DEAL-1')
    }
    if (options.rep !== null) {
      form.append('rep', options.rep ?? JSON.stringify({ by: 'speaker', label: 'Alex' }))
    }
    for (const [name, value] of Object.entries(options.extra ?? {})) {
      form.append(name, value)
    }
    return h.app.request(CALLS, {
      method: 'POST',
      body: form,
      headers: {
        ...auth,
        ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
        ...options.headers,
      },
    })
  }
  const runCalls = async () => {
    let total = 0
    for (let pass = 0; pass < 50; pass++) {
      const ran = await h.deps.workers.ingestion.runPass({ withoutRetag: true })
      total += ran
      if (ran === 0) {
        break
      }
    }
    return total
  }
  const readCall: CallHarness['readCall'] = async (callId, as) =>
    callSchema.parse(await (await send('GET', `${CALLS}/${callId}`, { as })).json())
  const listAll: CallHarness['listAll'] = async (query = '') => {
    const calls: Call[] = []
    let cursor: string | null = null
    do {
      const page: string = `limit=100${query === '' ? '' : `&${query}`}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      const response = await send('GET', `${CALLS}?${page}`)
      const body = listCallsResponseSchema.parse(await response.json())
      calls.push(...body.items)
      cursor = body.nextCursor
    } while (cursor !== null)
    return calls
  }
  const moments: CallHarness['moments'] = async (callId) => {
    const hits = await h.deps.vectors.search(h.organizationId, {
      vector: new Array<number>(h.deps.vectors.dimensions).fill(0.1),
      topK: 100,
      filter: { call_id: callId },
    })
    // Through the scoped statement, not the database double's rows: the same code reads Postgres.
    const read = (
      await h.deps.scope(h.organizationId, (run) => run(CALL_GET, [h.organizationId, callId]))
    ).rows[0]
    const row =
      read === undefined ? undefined : { epoch: Number(read.epoch), repSeq: Number(read.rep_seq) }
    const inSearch = row === undefined ? false : (await readCall(callId)).inSearch
    const returnable = hits.filter(
      (hit) =>
        row !== undefined &&
        momentMayBeReturned(
          {
            outcome: String(hit.attributes.outcome) as MomentTag['outcome'],
            outcomeSeq: Number(hit.attributes.outcome_seq),
            epoch: Number(hit.attributes.epoch),
            repSeq: Number(hit.attributes.rep_seq),
          },
          { inSearch, epoch: row.epoch, repSeq: row.repSeq }
        )
    ).length
    return {
      total: hits.length,
      returnable,
      outcomes: [...new Set(hits.map((hit) => String(hit.attributes.outcome)))].sort(),
    }
  }
  const setOutcome: CallHarness['setOutcome'] = async (dealRecordId, outcome) => {
    const response = await send('PUT', `/v1/playbook/deals/${dealRecordId}/outcome`, {
      body: { outcome },
    })
    if (response.status !== 200) {
      throw new Error(`setting the Outcome answered ${response.status}`)
    }
    return (
      h.deps.database.deals(h.organizationId).find((d) => d.id === dealRecordId)?.outcome_seq ?? -1
    )
  }
  return { ...h, send, uploadCall, confirmRights, runCalls, readCall, listAll, moments, setOutcome }
}
