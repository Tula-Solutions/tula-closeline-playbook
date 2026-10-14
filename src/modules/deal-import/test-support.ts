import { listDealImportRowsResponseSchema } from 'tula-closeline-contract'
import { createDocumentHarness, type DocumentHarness } from '~/modules/document/test-support'
import type { TestDepsOverrides, TestIdentity } from '~/testing'

/** The Deal import routes, relative to the app. */
export const IMPORTS = '/v1/playbook/deal-imports'

/** The template header with the optional name column. */
export const HEADER = 'deal_id,outcome,closed_at,amount,currency,name'

/** A CSV text: the header, then one line per row (a row is its cells joined by commas). */
export function csv(rows: readonly string[], header: string = HEADER): string {
  return `${[header, ...rows].join('\n')}\n`
}

/** A harness for the import routes and job over the database double. */
export type ImportHarness = DocumentHarness & {
  /** A request to an import route as `identity` (an Owner by default). */
  send(
    method: string,
    path: string,
    options?: { as?: TestIdentity | null; body?: unknown }
  ): Promise<Response>
  /** Uploads `text` as `name` as `identity` (an Owner by default). */
  uploadCsv(
    text: string | Uint8Array,
    options?: {
      name?: string
      type?: string
      as?: TestIdentity | null
      key?: string
      headers?: Record<string, string>
    }
  ): Promise<Response>
  /** Runs the job loop's passes until no import is claimed; returns the imports run. */
  runImports(): Promise<number>
  /** Every report row of an import, read through the route, page by page. */
  report(
    importId: string,
    result?: 'applied' | 'rejected'
  ): Promise<{ rowNumber: number; reason: string | null; dealId: string | null }[]>
}

/** Builds the app over the database double with the import job enabled. */
export async function createImportHarness(
  overrides: TestDepsOverrides = {}
): Promise<ImportHarness> {
  const h = await createDocumentHarness({
    ...overrides,
    env: { IMPORTS_ENABLED: 'true', ...overrides.env },
  })
  const send: ImportHarness['send'] = async (method, path, options = {}) => {
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
  const uploadCsv: ImportHarness['uploadCsv'] = async (text, options = {}) => {
    const auth = options.as === null ? {} : await h.bearer(options.as ?? h.people.owner)
    const form = new FormData()
    form.append(
      'file',
      new File([text], options.name ?? 'deals.csv', { type: options.type ?? 'text/csv' })
    )
    return h.app.request(IMPORTS, {
      method: 'POST',
      body: form,
      headers: {
        ...auth,
        ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
        ...options.headers,
      },
    })
  }
  const runImports = async () => {
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
  const report: ImportHarness['report'] = async (importId, result) => {
    const rows: { rowNumber: number; reason: string | null; dealId: string | null }[] = []
    let cursor: string | null = null
    do {
      const query: string = `limit=100${result === undefined ? '' : `&result=${result}`}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      const response = await send('GET', `${IMPORTS}/${importId}/rows?${query}`)
      const page = listDealImportRowsResponseSchema.parse(await response.json())
      rows.push(
        ...page.items.map((r) => ({ rowNumber: r.rowNumber, reason: r.reason, dealId: r.dealId }))
      )
      cursor = page.nextCursor
    } while (cursor !== null)
    return rows
  }
  return { ...h, send, uploadCsv, runImports, report }
}
