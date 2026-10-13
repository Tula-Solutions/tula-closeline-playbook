// Runs the ingestion pipeline's database statements against the compose Postgres
// (`bun run test:integration`); it is not part of `bun test src`. The unit suite runs the pipeline on
// a double of the database; this runs the db library's real claim, advance, cleanup, purge and
// discovery statements, under row-level security. Objects, vectors, parser and embedder stay in
// memory: those adapters are other tickets.
import { afterAll, describe, expect, test } from 'bun:test'
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
    await withOrganization(owner.db, h.organizationId, (tx) =>
      tx.execute(
        sql`update playbook.documents set purge_due_at = now() - interval '1 minute' where id = ${id}`
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
