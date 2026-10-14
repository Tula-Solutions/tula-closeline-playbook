import { type Call, callSchema, listCallsResponseSchema } from 'tula-closeline-contract'
import { createDocumentHarness, type DocumentHarness } from '~/modules/document/test-support'
import type { TestDepsOverrides, TestIdentity } from '~/testing'

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
  /** Runs the job loop's passes until no Call job is claimed; returns the jobs run. */
  runCalls(): Promise<number>
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
      const ran = await h.deps.workers.ingestion.runPass()
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
  return { ...h, send, uploadCall, confirmRights, runCalls, readCall, listAll }
}
