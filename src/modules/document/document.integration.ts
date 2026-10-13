// Runs the document routes against the compose Postgres (`bun run test:integration`); it is not
// part of `bun test src`. The unit suite runs the routes on a double of the database; this runs the
// db library's real statements, which is the only place their SQL, row-level security, the quota
// triggers, the key table and the `created_at::text` cursor are exercised through the routes.

import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  documentSchema,
  listDocumentsResponseSchema,
  type PlaybookDocument,
} from 'tula-closeline-contract'
import { createDb, IDEMPOTENCY_BEGIN, withOrganization } from 'tula-closeline-db'
import { scopeOver } from '~/adapters/postgres/processed-store'
import { integrationUrls } from '~/integration-support'
import { newOrganizationId } from '~/testing'
import { UPLOAD_IDEMPOTENCY_ROUTE } from './service'
import {
  createDocumentHarness,
  DOCUMENTS,
  errorCode,
  INTERNAL_SECRET,
  newKey,
  pdfBytes,
  personIn,
} from './test-support'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
afterAll(async () => {
  await Promise.allSettled([service.close(), owner.close()])
})

/** A harness over the real database, with its own Organization and its own people. */
async function harness(env: Record<string, string> = {}) {
  return createDocumentHarness({ scope: scopeOver(service.db), env })
}

/** Runs a statement as the table owner, in one Organization's scope, to set up what the routes cannot reach. */
async function asOwner(organizationId: string, statement: ReturnType<typeof sql>): Promise<void> {
  await withOrganization(owner.db, organizationId, (tx) => tx.execute(statement))
}

async function documentOf(response: Response): Promise<PlaybookDocument> {
  return documentSchema.parse(await response.json())
}

describe('upload against Postgres', () => {
  test('stores a document, finds the duplicate by the SHA-256 of the content, and queues one job', async () => {
    const h = await harness()

    const first = await h.upload('a.pdf', pdfBytes('integration-a'))
    const again = await h.upload('b.pdf', pdfBytes('integration-a'))

    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect((await documentOf(again)).id).toBe((await documentOf(first)).id)
    const jobs = await withOrganization(service.db, h.organizationId, (tx) =>
      tx.execute(sql`select count(*)::int as n from playbook.ingestion_jobs`)
    )
    expect(jobs.rows[0]).toEqual({ n: 1 })
  })

  test('counts soft-deleted documents toward the quota, by count and by bytes', async () => {
    const h = await harness({ MAX_DOCUMENTS_PER_ORGANIZATION: '1' })
    const first = await documentOf(await h.upload('a.pdf', pdfBytes('quota-a')))
    await h.call('DELETE', `${DOCUMENTS}/${first.id}`)

    const refused = await h.upload('b.pdf', pdfBytes('quota-b'))

    expect(refused.status).toBe(409)
    expect(await errorCode(refused)).toBe('document.quota_exceeded')
    const bytes = await harness({
      MAX_BYTES_PER_ORGANIZATION: String(pdfBytes('quota-c').byteLength),
    })
    expect((await bytes.upload('c.pdf', pdfBytes('quota-c'))).status).toBe(201)
    expect((await bytes.upload('d.pdf', pdfBytes('quota-d'))).status).toBe(409)
  })

  test('two uploads of the same content at once make one document', async () => {
    const h = await harness()

    const [a, b] = await Promise.all([
      h.upload('a.pdf', pdfBytes('race')),
      h.upload('b.pdf', pdfBytes('race')),
    ])

    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test('replays an idempotency key from the key table, refuses another file under it, and two at once make one document', async () => {
    const h = await harness()
    const key = newKey()

    const [a, b] = await Promise.all([
      h.upload('a.pdf', pdfBytes('keyed'), { key }),
      h.upload('a.pdf', pdfBytes('keyed'), { key }),
    ])
    const replay = await h.upload('a.pdf', pdfBytes('keyed'), { key })
    const other = await h.upload('b.pdf', pdfBytes('other'), { key })

    // The call that waited on the key's row replays the winner's stored answer, which is the 201 it
    // stored (core's pattern); only a lock timeout would be 409. Either way one document results.
    expect([a.status, b.status].every((status) => status === 201 || status === 409)).toBe(true)
    expect([a.status, b.status]).toContain(201)
    if (a.status === 201 && b.status === 201) {
      expect((await documentOf(a)).id).toBe((await documentOf(b)).id)
    }
    expect(await h.objectKeys()).toHaveLength(1)
    expect(replay.status).toBe(201)
    expect(other.status).toBe(422)
    const count = await withOrganization(service.db, h.organizationId, (tx) =>
      tx.execute(sql`select count(*)::int as n from playbook.documents`)
    )
    expect(count.rows[0]).toEqual({ n: 1 })
  })

  test('a key held open by another transaction past the lock timeout is request.idempotency_in_progress (409) with Retry-After, and nothing is stored', async () => {
    const h = await harness()
    const key = newKey()
    const holding = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = scopeOver(service.db)(h.organizationId, async (run) => {
      await run(IDEMPOTENCY_BEGIN, [
        h.organizationId,
        h.people.owner.userId,
        UPLOAD_IDEMPOTENCY_ROUTE,
        key,
        createHash('sha256').update('held').digest(),
      ])
      holding.resolve()
      await release.promise
      throw new Error('roll the held key back')
    }).catch(() => undefined)
    await holding.promise

    // The held row is uncommitted, so this call's insert of the same key waits for it and gives up
    // when the two second lock timeout runs out.
    const blocked = await h.upload('a.pdf', pdfBytes('held-key'), { key })
    release.resolve()
    await holder

    expect(blocked.status).toBe(409)
    expect(await errorCode(blocked)).toBe('request.idempotency_in_progress')
    expect(blocked.headers.get('retry-after')).not.toBeNull()
    expect(await h.objectKeys()).toEqual([])
    const after = await h.upload('a.pdf', pdfBytes('held-key'), { key })
    expect(after.status).toBe(201)
  })

  test('the owner of another Organization cannot read, list, delete or restore it', async () => {
    const h = await harness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('tenant')))
    const stranger = personIn(newOrganizationId(), 'owner')

    const read = await h.call('GET', `${DOCUMENTS}/${created.id}`, { as: stranger })
    const listed = await h.call('GET', DOCUMENTS, { as: stranger })
    const deleted = await h.call('DELETE', `${DOCUMENTS}/${created.id}`, { as: stranger })
    const restored = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`, { as: stranger })

    expect(read.status).toBe(404)
    expect(deleted.status).toBe(404)
    expect(restored.status).toBe(404)
    expect(listDocumentsResponseSchema.parse(await listed.json()).items).toEqual([])
  })
})

describe('list, delete and restore against Postgres', () => {
  test('pages through documents created in the same instant by the microsecond cursor, with none lost or repeated', async () => {
    const h = await harness()
    // The table refuses to rewrite created_at, so the tie is made at insert: every row carries one
    // microsecond-precision instant, as the db library's own suite does.
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = `doc_${crypto.randomUUID().replaceAll('-', '')}`
      ids.push(id)
      await withOrganization(service.db, h.organizationId, (tx) =>
        tx.execute(sql`
          insert into playbook.documents
            (id, organization_id, name, content_hash, size_bytes, declared_type, detected_type, uploaded_by, object_key, created_at)
          values (${id}, ${h.organizationId}, ${`${i}.pdf`}, decode(${createHash('sha256').update(`page-${i}`).digest('hex')}, 'hex'),
            10, 'application/pdf', 'pdf', ${h.people.owner.userId}, ${`k${i}`}, '2026-01-01 00:00:00.000001+00')`)
      )
    }

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const response = await h.call(
        'GET',
        `${DOCUMENTS}?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`
      )
      const page = listDocumentsResponseSchema.parse(await response.json())
      seen.push(...page.items.map((d) => d.id))
      cursor = page.nextCursor
    } while (cursor !== null)

    expect(seen).toEqual([...ids].sort().reverse())
  })

  test('filters by state and leaves deleted documents out unless asked', async () => {
    const h = await harness()
    const kept = await documentOf(await h.upload('a.pdf', pdfBytes('state-a')))
    const gone = await documentOf(await h.upload('b.pdf', pdfBytes('state-b')))
    await h.call('DELETE', `${DOCUMENTS}/${gone.id}`)

    const uploaded = listDocumentsResponseSchema.parse(
      await (await h.call('GET', `${DOCUMENTS}?state=uploaded`)).json()
    )
    const deleted = listDocumentsResponseSchema.parse(
      await (await h.call('GET', `${DOCUMENTS}?state=deleted`)).json()
    )

    expect(uploaded.items.map((d) => d.id)).toEqual([kept.id])
    expect(deleted.items.map((d) => d.id)).toEqual([gone.id])
  })

  test('delete is idempotent, restore works within retention and is 410 after it by the database clock', async () => {
    const h = await harness()
    const created = await documentOf(await h.upload('a.pdf', pdfBytes('life')))

    const first = await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    const second = await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    const restored = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)
    await h.call('DELETE', `${DOCUMENTS}/${created.id}`)
    await asOwner(
      h.organizationId,
      sql`update playbook.documents
            set deleted_at = deleted_at - interval '31 days', purge_due_at = purge_due_at - interval '31 days'`
    )
    const late = await h.call('POST', `${DOCUMENTS}/${created.id}/restore`)

    expect(await first.json()).toEqual(await second.json())
    expect((await documentOf(restored)).state).toBe('processing')
    expect(late.status).toBe(410)
    expect(await errorCode(late)).toBe('document.not_restorable')
  })
})

describe('the internal remove-all route against Postgres', () => {
  test('erases, waits for the purge, then answers removed, and touches no other Organization', async () => {
    const h = await harness()
    const other = personIn(newOrganizationId(), 'owner')
    await h.upload('a.pdf', pdfBytes('rm-a'))
    await h.upload('b.pdf', pdfBytes('rm-b'))
    await h.upload('c.pdf', pdfBytes('rm-c'), { as: other })
    const call = (key: string) =>
      h.app.request(`/internal/playbook/organizations/${h.organizationId}/remove-all`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'idempotency-key': key },
      })
    const key = newKey()

    const early = await call(key)
    // The purge sweep (hub issue 14, round B) removes the rows; the test stands in for it.
    await asOwner(h.organizationId, sql`delete from playbook.ingestion_jobs`)
    await asOwner(h.organizationId, sql`delete from playbook.documents`)
    const done = await call(key)
    const replay = await call(key)

    expect(early.status).toBe(503)
    expect(done.status).toBe(200)
    expect(replay.status).toBe(200)
    const theirs = listDocumentsResponseSchema.parse(
      await (await h.call('GET', DOCUMENTS, { as: other })).json()
    )
    expect(theirs.items).toHaveLength(1)
  })
})
