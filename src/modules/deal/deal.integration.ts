// Runs the Deal and rights routes against the compose Postgres (`bun run test:integration`); it is
// not part of `bun test src`. The unit suite runs them on a double of the database; this runs the
// db library's real statements: row-level security, the `created_at::text` cursor, the Outcome
// sequence and the rights upsert. Deals are seeded as the table owner under the upload lock,
// because no route creates one until the import ticket.

import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  CURRENT_RIGHTS_WORDING_VERSION,
  dealSchema,
  encodeCursor,
  listDealsResponseSchema,
  rightsStatusSchema,
} from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { scopeOver } from '~/adapters/postgres/processed-store'
import { integrationUrls } from '~/integration-support'
import {
  createDocumentHarness,
  errorCode,
  INTERNAL_SECRET,
  personIn,
} from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
afterAll(async () => {
  await Promise.allSettled([service.close(), owner.close()])
})

const DEALS = '/v1/playbook/deals'
const RIGHTS = '/v1/playbook/rights-confirmation'
const dealRecord = () => `deal_${crypto.randomUUID().replaceAll('-', '')}`

/** A harness over the real database, with its own Organization and its own people. */
async function harness() {
  const h = await createDocumentHarness({ scope: scopeOver(service.db) })
  const send = async (method: string, path: string, body?: unknown, as = h.people.owner) =>
    h.app.request(path, {
      method,
      headers: {
        ...(await h.bearer(as)),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { h, send }
}

/** Inserts Deals as the table owner, holding the Organization's upload lock as the insert trigger requires. */
async function seedDeals(organizationId: string, dealIds: string[], createdAt?: string) {
  const ids: string[] = []
  await withOrganization(owner.db, organizationId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}::text, 0))`
    )
    for (const dealId of dealIds) {
      const id = dealRecord()
      ids.push(id)
      await tx.execute(
        sql`insert into playbook.deals (id, organization_id, deal_id, created_at)
            values (${id}, ${organizationId}, ${dealId}, coalesce(${createdAt ?? null}::timestamptz, now()))`
      )
    }
  })
  return ids
}

describe('Deals against Postgres', () => {
  test('pages with the statement cursor without skipping Deals created in the same instant', async () => {
    const { h, send } = await harness()
    await seedDeals(h.organizationId, ['A', 'B', 'C', 'D', 'E'], '2026-01-01T00:00:00.123456Z')

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const response = await send(
        'GET',
        `${DEALS}?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      )
      const body = listDealsResponseSchema.parse(await response.json())
      seen.push(...body.items.map((item) => item.dealId))
      cursor = body.nextCursor
      if (cursor === null) {
        break
      }
    }

    expect(seen.sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  test.each([
    ['year zero', '0000-01-01T00:00:00+00:00'],
    ['a day the month does not have', '2026-02-30T00:00:00+00:00'],
  ])(
    'a cursor the database refuses (%s) is request.invalid on every list, not a 500',
    async (_label, createdAt) => {
      const { h, send } = await harness()
      const cursor = encodeURIComponent(encodeCursor({ createdAt, id: dealRecord() } as never))

      for (const filter of ['', '&outcome=won', '&appearedInImport=true']) {
        const response = await send('GET', `${DEALS}?cursor=${cursor}${filter}`)

        expect(response.status).toBe(400)
        expect(await errorCode(response)).toBe('request.invalid')
      }
      expect(h.deps.reported).toEqual([])
    }
  )

  test('looks a Deal up by the customer id and sets its Outcome once, moving the sequence once', async () => {
    const { h, send } = await harness()
    const [id] = await seedDeals(h.organizationId, ['ACME-1'])

    const found = dealSchema.parse(
      await (await send('POST', `${DEALS}/lookup`, { dealId: 'ACME-1' })).json()
    )
    const first = await send('PUT', `${DEALS}/${id}/outcome`, { outcome: 'won' })
    const repeat = await send('PUT', `${DEALS}/${id}/outcome`, { outcome: 'won' })

    expect(found.id).toBe(id as never)
    expect(first.status).toBe(200)
    expect(repeat.status).toBe(200)
    expect(h.published).toHaveLength(1)
    expect(JSON.parse(JSON.stringify(h.published[0]?.payload))).toEqual({
      dealRecordId: id,
      outcomeSeq: 1,
    })
  })

  test('a second Organization can neither see nor change the Deals of the first', async () => {
    const { h, send } = await harness()
    const [id] = await seedDeals(h.organizationId, ['PRIVATE-1'])
    const stranger = personIn(newOrganizationId(), 'owner')

    const read = await send('GET', `${DEALS}/${id}`, undefined, stranger)
    const change = await send('PUT', `${DEALS}/${id}/outcome`, { outcome: 'lost' }, stranger)
    const listed = listDealsResponseSchema.parse(
      await (await send('GET', DEALS, undefined, stranger)).json()
    )

    expect(read.status).toBe(404)
    expect(change.status).toBe(404)
    expect(listed.items).toEqual([])
  })
})

describe('the rights confirmation against Postgres', () => {
  test('records once, keeps the first record on a repeat, and is separate per Organization', async () => {
    const { h, send } = await harness()
    const stranger = personIn(newOrganizationId(), 'owner')

    const first = rightsStatusSchema.parse(
      await (await send('PUT', RIGHTS, { wordingVersion: CURRENT_RIGHTS_WORDING_VERSION })).json()
    )
    const repeat = rightsStatusSchema.parse(
      await (await send('PUT', RIGHTS, { wordingVersion: CURRENT_RIGHTS_WORDING_VERSION })).json()
    )
    const other = rightsStatusSchema.parse(
      await (await send('GET', RIGHTS, undefined, stranger)).json()
    )
    const outdated = await send('PUT', RIGHTS, {
      wordingVersion: CURRENT_RIGHTS_WORDING_VERSION + 1,
    })

    expect(first.confirmed).toBe(true)
    expect(repeat.confirmation).toEqual(first.confirmation)
    expect(other.confirmed).toBe(false)
    expect(outdated.status).toBe(409)
    expect(h.organizationId).toBeDefined()
  })
})

describe('remove-all against Postgres', () => {
  test('erases Deals in batches and the rights confirmation, then answers removed', async () => {
    const { h, send } = await harness()
    await seedDeals(h.organizationId, ['X-1', 'X-2'])
    await send('PUT', RIGHTS, { wordingVersion: CURRENT_RIGHTS_WORDING_VERSION })

    const response = await h.app.request(
      `/internal/playbook/organizations/${h.organizationId}/remove-all`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${INTERNAL_SECRET}`,
          'idempotency-key': crypto.randomUUID(),
        },
      }
    )

    expect(response.status).toBe(200)
    const left = await withOrganization(service.db, h.organizationId, (tx) =>
      tx.execute(sql`select count(*)::int as n from playbook.deals`)
    )
    expect(left.rows[0]).toEqual({ n: 0 })
  })
})
