// Runs the ingestion pipeline's database statements against the compose Postgres
// (`bun run test:integration`); it is not part of `bun test src`. The unit suite runs the pipeline on
// a double of the database; this runs the db library's real claim, advance, cleanup, purge and
// discovery statements, under row-level security. Objects, vectors, parser and embedder stay in
// memory: those adapters are other tickets.
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  createDb,
  ORGANIZATIONS_WITH_WORK,
  type WorkDiscoveryRow,
  withOrganization,
} from 'tula-closeline-db'
import { type Discover, scopeOver, statementOf } from '~/adapters/postgres/processed-store'
import { integrationUrls } from '~/integration-support'
import * as Documents from '~/modules/document/service'
import { cleanupPending } from '~/modules/maintenance/cleanup-pending'
import { visitOrphanSweep } from '~/modules/maintenance/housekeeping'
import { createPipelineHarness, paragraphs } from './test-support'

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

/** A harness whose database access is the real one; time is virtual, so database clocks are compared only through rows set up here. */
function harness() {
  const h = createPipelineHarness()
  h.deps.scope = scopeOver(service.db)
  h.deps.discover = discover
  return h
}

/** Moves the harness's virtual clock to the real time, since the database stamps rows with its own clock. */
async function catchUp(h: ReturnType<typeof harness>): Promise<void> {
  await h.deps.time.advance(Date.now() - h.deps.clock.now().getTime())
}

const never = new AbortController().signal

describe('the pipeline against Postgres', () => {
  test('an uploaded document is claimed, advanced through every step and ends ready, with its vectors', async () => {
    const h = harness()
    const id = await h.upload('notes.txt', paragraphs(4))

    await h.pass()

    const rows = await withOrganization(owner.db, h.organizationId, (tx) =>
      tx.execute<{ state: string; chunks: number | null }>(
        sql`select state, page_count as chunks from playbook.documents where id = ${id}`
      )
    )
    expect(rows.rows[0]?.state).toBe('ready')
    expect((await h.vectorIds(id)).length).toBeGreaterThan(0)
  })

  test('discovery names an Organization with a due job, and another Organization sees none of its documents', async () => {
    const h = harness()
    await h.upload('notes.txt', paragraphs(2))

    const found: string[] = []
    let after = ''
    for (;;) {
      const page = await discover('jobs_due', after, 100)
      found.push(
        ...page.flatMap((row) => (row.organization_id === null ? [] : [row.organization_id]))
      )
      const last = page.at(-1)
      if (last === undefined || page.length < 100) {
        break
      }
      after = last.organization_id ?? after
    }
    expect(found).toContain(h.organizationId)

    const other = h.other()
    const listed = await Documents.list(h.deps, other, { limit: 10 })
    expect(listed.items).toEqual([])
  })

  test('a deleted document is cleaned and then purged once past retention', async () => {
    const h = harness()
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    // Both columns move together (a check ties them), and the update fires the trigger that notes
    // the work hint at the earlier time, which is how discovery finds the purge as due.
    await withOrganization(owner.db, h.organizationId, (tx) =>
      tx.execute(
        sql`update playbook.documents set deleted_at = deleted_at - interval '31 days', purge_due_at = purge_due_at - interval '31 days'
          where id = ${id}`
      )
    )

    await h.deps.workers.sweeps.run('purge')

    const rows = await withOrganization(owner.db, h.organizationId, (tx) =>
      tx.execute(sql`select id from playbook.documents where id = ${id}`)
    )
    expect(rows.rows).toEqual([])
    expect(await h.vectorIds(id)).toEqual([])
  })
})

describe('the db v0.13.0 statements against Postgres', () => {
  test('DOCUMENT_LIST_PENDING_CLEANUP lists a deleted document until its cleanup is recorded', async () => {
    const h = harness()
    await catchUp(h)
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    // Deleted ten minutes ago: past the five-minute floor, and (by the update trigger) hinted.
    await withOrganization(owner.db, h.organizationId, (tx) =>
      tx.execute(
        sql`update playbook.documents
              set deleted_at = deleted_at - interval '10 minutes', purge_due_at = purge_due_at - interval '10 minutes'
            where id = ${id}`
      )
    )
    const named = async () =>
      (await discover('cleanup_pending', '', 500)).map((row) => row.organization_id)
    expect(await named()).toContain(h.organizationId)

    expect(await cleanupPending(h.deps, h.organizationId, never)).toBe(1)

    expect(await h.vectorIds(id)).toEqual([])
    expect(await named()).not.toContain(h.organizationId)
    expect(await cleanupPending(h.deps, h.organizationId, never)).toBe(0)
  })

  test('an Organization whose only trace is an old upload attempt is swept and marked done with ORPHAN_SWEEP_DONE', async () => {
    const h = harness()
    await catchUp(h)
    const orphan = `documents/doc_${'c'.repeat(32)}/original.pdf`
    await h.deps.objects.put(h.organizationId, orphan, new Uint8Array([1]))
    // An upload attempt made 26 hours ago (the key insert notes the hint at its time plus 25 hours).
    await withOrganization(owner.db, h.organizationId, (tx) =>
      tx.execute(
        sql`insert into playbook.idempotency_keys (organization_id, user_id, route, key, request_hash, created_at)
            values (${h.organizationId}, ${h.context.userId}, 'documents.upload', ${`k-${crypto.randomUUID()}`},
                    decode(repeat('ab', 32), 'hex'), clock_timestamp() - interval '26 hours')`
      )
    )
    const named = async () =>
      (await discover('orphan_sweep', '', 500)).map((row) => row.organization_id)
    expect(await named()).toContain(h.organizationId)
    await h.deps.time.advance(30 * 60 * 60 * 1000)

    const visit = await visitOrphanSweep(h.deps, h.organizationId, never)

    expect(visit).toEqual({ status: 'done', deleted: 1, more: false })
    expect(await h.deps.objects.head(h.organizationId, orphan)).toBeUndefined()
    expect(await named()).not.toContain(h.organizationId)
  })
  test('an upload whose object write landed and whose answer was lost is swept through the real upload path', async () => {
    const h = harness()
    await catchUp(h)
    const put = h.deps.objects.put.bind(h.deps.objects)
    spyOn(h.deps.objects, 'put').mockImplementation(async (org, key, body, options) => {
      await put(org, key, body, options)
      throw new Error('the connection dropped after the write')
    })
    await expect(h.upload('notes.txt', paragraphs(2))).rejects.toBeDefined()
    const listed = () => h.deps.objects.list(h.organizationId, { prefix: 'documents/' })
    expect((await listed()).items).toHaveLength(1)
    // The only key the upload path wrote is the attempt record; the test inserts none.
    const keyRoutes = () =>
      withOrganization(owner.db, h.organizationId, (tx) =>
        tx.execute<{ route: string }>(sql`select route from playbook.idempotency_keys`)
      )
    expect((await keyRoutes()).rows.map((row: { route: string }) => row.route)).toEqual([
      'documents.upload_attempt',
    ])
    // Age that row as the table owner. The `idempotency_keys_final` trigger (which refuses any
    // change of `created_at`) is disabled and re-enabled inside this one transaction, so no other
    // session ever sees it off and the product's rule is untouched.
    await withOrganization(owner.db, h.organizationId, async (tx) => {
      await tx.execute(
        sql`alter table playbook.idempotency_keys disable trigger idempotency_keys_final`
      )
      await tx.execute(
        sql`update playbook.idempotency_keys set created_at = clock_timestamp() - interval '26 hours'
            where organization_id = ${h.organizationId} and route = 'documents.upload_attempt'`
      )
      await tx.execute(
        sql`alter table playbook.idempotency_keys enable trigger idempotency_keys_final`
      )
    })
    await h.deps.time.advance(30 * 60 * 60 * 1000)

    const visit = await visitOrphanSweep(h.deps, h.organizationId, never)

    expect(visit).toMatchObject({ status: 'done', deleted: 1 })
    expect((await listed()).items).toEqual([])
  })
})
