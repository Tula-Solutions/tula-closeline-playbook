// Runs the Deal import routes and job against the compose Postgres (`bun run test:integration`); it
// is not part of `bun test src`. The unit suite runs them on a double of the database; this runs the
// db library's real statements: the claim, the apply under the upload lock and row-level security,
// the resumable report, the text cursor and the erase and purge steps. Objects and the queue stay
// in memory.

import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  type DealImport,
  dealImportSchema,
  encodeCursor,
  listDealImportsResponseSchema,
} from 'tula-closeline-contract'
import {
  createDb,
  DEAL_IMPORT_APPLY,
  ORGANIZATIONS_WITH_WORK,
  type WorkDiscoveryRow,
  withOrganization,
} from 'tula-closeline-db'
import { type Discover, scopeOver, statementOf } from '~/adapters/postgres/processed-store'
import { integrationUrls } from '~/integration-support'
import { errorCode, INTERNAL_SECRET, newKey, personIn } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'
import { createImportHarness, csv, IMPORTS } from './test-support'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
afterAll(async () => {
  await Promise.allSettled([service.close(), owner.close()])
})

const discover: Discover = (kind, after, batch) =>
  service.db.transaction(async (tx) => {
    const result = await tx.execute(statementOf(ORGANIZATIONS_WITH_WORK, [kind, after, batch]))
    return result.rows as unknown as WorkDiscoveryRow[]
  })

/** A harness over the real database, with its own Organization and its own people. */
async function harness() {
  const h = await createImportHarness({
    scope: scopeOver(service.db),
    env: { MAX_DEALS_PER_ORGANIZATION: '100000' },
  })
  h.deps.discover = discover
  return h
}

type Harness = Awaited<ReturnType<typeof harness>>

const deal = (n: number) => `deal_${n.toString(16).padStart(32, '0')}`

/** Uploads a CSV and returns the import's id. */
async function upload(h: Harness, text: string, key?: string): Promise<string> {
  const response = await h.uploadCsv(text, key === undefined ? {} : { key })
  expect(response.status).toBe(202)
  return dealImportSchema.parse(await response.json()).id
}

async function read(h: Harness, importId: string): Promise<DealImport> {
  return dealImportSchema.parse(await (await h.send('GET', `${IMPORTS}/${importId}`)).json())
}

/** Counts rows of a table in an Organization, as the table owner under that Organization's scope. */
async function count(organizationId: string, table: string): Promise<number> {
  const result = await withOrganization(owner.db, organizationId, (tx) =>
    tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from playbook.${table}`))
  )
  return result.rows[0]?.n ?? -1
}

/** Makes every import of an Organization due now, so a retry does not wait for the real clock. */
async function makeDue(organizationId: string): Promise<void> {
  await withOrganization(owner.db, organizationId, (tx) =>
    tx.execute(
      sql`update playbook.deal_imports set next_attempt_at = now() - interval '1 minute' where state = 'uploaded'`
    )
  )
}

describe('a Deal import against Postgres', () => {
  test('is uploaded, claimed by discovery, applied in batches and reported row by row', async () => {
    const h = await harness()
    const id = await upload(
      h,
      csv([
        `${deal(1)},won,2025-03-14,1200.50,USD,Acme`,
        `${deal(2)},lost,,,,`,
        `${deal(1)},won,,,,`,
        `${deal(3)},sideways,,,,`,
      ])
    )

    await h.runImports()

    expect(await read(h, id)).toMatchObject({
      state: 'completed',
      rowCount: 4,
      appliedCount: 2,
      rejectedCount: 2,
    })
    expect(await count(h.organizationId, 'deals')).toBe(2)
    const rejected = await h.report(id, 'rejected')
    expect(rejected.map((r) => r.rowNumber)).toEqual([4, 5])
    expect((await h.report(id)).map((r) => r.rowNumber)).toEqual([2, 3, 4, 5])
  })

  test('moves a Deal that was open to won once, and publishes its Outcome change after the commit', async () => {
    const h = await harness()
    await upload(h, csv([`${deal(10)},open,,,,`]))
    await h.runImports()
    expect(h.published).toHaveLength(0)

    await upload(h, csv([`${deal(10)},won,2025-03-14,,,`]), newKey())
    await h.runImports()

    expect(h.published).toHaveLength(1)
    expect(JSON.parse(JSON.stringify(h.published[0]?.payload))).toMatchObject({ outcomeSeq: 1 })
  })

  test('resumes from the report after a failure between batches without applying a row twice', async () => {
    const h = await harness()
    const id = await upload(
      h,
      csv(Array.from({ length: 1100 }, (_, i) => `${deal(1000 + i)},open,,,,`))
    )
    const base = h.deps.scope
    let applies = 0
    h.deps.scope = (organizationId, work) =>
      base(organizationId, (run) =>
        work(async (text, params) => {
          if (text === DEAL_IMPORT_APPLY && ++applies === 2) {
            throw new Error('connection lost')
          }
          return run(text, params)
        })
      )
    await h.runImports()
    expect(await count(h.organizationId, 'deals')).toBe(500)
    h.deps.scope = base

    await makeDue(h.organizationId)
    await h.runImports()

    expect(await read(h, id)).toMatchObject({
      state: 'completed',
      rowCount: 1100,
      appliedCount: 1100,
    })
    expect(await count(h.organizationId, 'deals')).toBe(1100)
    expect(await count(h.organizationId, 'deal_import_rows')).toBe(1100)
  })

  test('a bad file fails the import and applies nothing', async () => {
    const h = await harness()
    const id = await upload(h, 'deal_id,outcome,closed_at,amount,currency\nA,won,,,"open\n')

    await h.runImports()

    expect(await read(h, id)).toMatchObject({ state: 'failed', failureReason: 'unreadable' })
    expect(await count(h.organizationId, 'deals')).toBe(0)
  })

  test('a cursor the database refuses is request.invalid, not a 500', async () => {
    const h = await harness()
    const cursor = encodeURIComponent(
      encodeCursor({
        createdAt: '0000-01-01T00:00:00+00:00',
        id: `dimp_${'1'.repeat(32)}`,
      } as never)
    )

    const response = await h.send('GET', `${IMPORTS}?cursor=${cursor}`)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('request.invalid')
    expect(h.deps.reported).toEqual([])
  })
})

describe('a second Organization against Postgres', () => {
  test('can neither see an import, its report or its Deals, nor change them', async () => {
    const h = await harness()
    const id = await upload(h, csv([`${deal(50)},won,,,,`]))
    await h.runImports()
    const stranger = personIn(newOrganizationId(), 'owner')

    const got = await h.send('GET', `${IMPORTS}/${id}`, { as: stranger })
    const rows = await h.send('GET', `${IMPORTS}/${id}/rows`, { as: stranger })
    const listed = listDealImportsResponseSchema.parse(
      await (await h.send('GET', IMPORTS, { as: stranger })).json()
    )

    expect(got.status).toBe(404)
    expect(rows.status).toBe(404)
    expect(listed.items).toEqual([])
    expect(await count(stranger.organizationId, 'deals')).toBe(0)
    expect(await count(stranger.organizationId, 'deal_imports')).toBe(0)
  })

  test('runs its own import beside the first and neither sees the other', async () => {
    const first = await harness()
    const second = await harness()
    await upload(first, csv([`${deal(60)},won,,,,`]))
    await upload(second, csv([`${deal(60)},lost,,,,`]))

    await first.runImports()
    await second.runImports()

    expect(await count(first.organizationId, 'deals')).toBe(1)
    expect(await count(second.organizationId, 'deals')).toBe(1)
  })
})

describe('remove-all against Postgres, with imports', () => {
  test('erases the imports, their reports and their files', async () => {
    const h = await harness()
    await upload(h, csv(Array.from({ length: 30 }, (_, i) => `${deal(200 + i)},open,,,,`)))
    await h.runImports()
    await upload(h, csv([`${deal(300)},open,,,,`]), newKey()) // still `uploaded`, its file stored
    expect(await h.objectKeys()).toHaveLength(1)

    let status = 503
    for (let call = 0; call < 20 && status === 503; call++) {
      const response = await h.app.request(
        `/internal/playbook/organizations/${h.organizationId}/remove-all`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'idempotency-key': newKey() },
        }
      )
      status = response.status
    }

    expect(status).toBe(200)
    expect(await count(h.organizationId, 'deal_import_rows')).toBe(0)
    expect(await count(h.organizationId, 'deals')).toBe(0)
    expect(await h.objectKeys()).toEqual([])
  })
})
