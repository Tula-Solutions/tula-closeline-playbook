// Runs document search against the compose Postgres (`bun run test:integration`); it is not part of
// `bun test src`. The unit suite runs the service over a double of the database; this runs the db
// library's real `DOCUMENT_SEARCH_STATE` statement (the array parameter, the row-level security
// scope and the epoch and state it returns). Objects, vectors, parser and embedder stay in memory.

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
import { requeueReadyDocuments } from '~/modules/document/reindex'
import * as Documents from '~/modules/document/service'
import { createPipelineHarness, paragraphs } from '~/modules/ingestion/test-support'
import { searchDocuments } from './documents'

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

/** A pipeline harness whose database access is the real one. */
function harness() {
  const h = createPipelineHarness()
  h.deps.scope = scopeOver(service.db)
  h.deps.discover = discover
  return h
}

const request = { turns: [{ role: 'prospect' as const, text: 'distinct about topic' }], limit: 5 }

describe('document search against Postgres', () => {
  test('finds a ready document and drops it once it is deleted, before the cleanup has run', async () => {
    const h = harness()
    const id = await h.upload('notes.txt', paragraphs(2, 'zz'))
    await h.pass()

    const found = await searchDocuments(h.deps, h.context, request)
    expect(found.items.every((item) => item.documentId === id)).toBe(true)
    expect(found.items.length).toBeGreaterThan(0)
    expect(found.items[0]).toMatchObject({ fileName: 'notes.txt', page: null })

    await Documents.remove(h.deps, h.context, id)

    expect((await searchDocuments(h.deps, h.context, request)).items).toEqual([])
  })

  test("a second Organization's document id planted in the caller's namespace is never returned", async () => {
    const mine = harness()
    const theirs = harness()
    const theirId = await theirs.upload('theirs.txt', paragraphs(2, 'yy'))
    await theirs.pass()
    const [vector] = await mine.deps.embedder.embed(['distinct about topic'], {
      purpose: 'query',
      signal: new AbortController().signal,
    })
    await mine.deps.vectors.upsert(mine.organizationId, [
      {
        id: 'planted:0',
        vector: vector ?? [],
        attributes: {
          document_id: theirId,
          epoch: 0,
          chunk: 0,
          page: 1,
          snippet: 'LEAKED-DOCUMENT-TEXT',
          kind: 'document',
          v: 2,
        },
      },
    ])

    const found = await searchDocuments(mine.deps, mine.context, request)

    expect(JSON.stringify(found)).not.toContain('LEAKED')
    expect(found.items).toEqual([])
  })
})

describe('the local-dev re-index statement against Postgres', () => {
  test('puts a ready document back in the queue at the same epoch, and the pipeline rewrites it', async () => {
    const h = harness()
    const id = await h.upload('notes.txt', paragraphs(2, 'rr'))
    await h.pass()
    const row = (organizationId: string, documentId: string) =>
      withOrganization(owner.db, organizationId, (tx) =>
        tx.execute<{ state: string; epoch: number }>(
          sql`select state, epoch from playbook.documents where id = ${documentId}`
        )
      ).then((result) => result.rows[0])
    const before = await row(h.organizationId, id)
    expect(before?.state).toBe('ready')

    const queued = await withOrganization(service.db, h.organizationId, (tx) =>
      requeueReadyDocuments(tx, h.organizationId, '', 10)
    )
    const again = await withOrganization(service.db, h.organizationId, (tx) =>
      requeueReadyDocuments(tx, h.organizationId, '', 10)
    )

    expect(queued).toEqual([id])
    // Its job is queued now, so a second run skips it.
    expect(again).toEqual([])
    expect(await row(h.organizationId, id)).toMatchObject({
      state: 'uploaded',
      epoch: before?.epoch,
    })
    expect(await h.pass()).toBe(1)
    expect(await row(h.organizationId, id)).toMatchObject({ state: 'ready', epoch: before?.epoch })
  })

  test('leaves a document that is not ready, and another Organization, alone', async () => {
    const mine = harness()
    const theirs = harness()
    await mine.upload('uploaded.txt', paragraphs(2, 'uu'))
    const theirId = await theirs.upload('theirs.txt', paragraphs(2, 'tt'))
    await theirs.pass()

    const queued = await withOrganization(service.db, mine.organizationId, (tx) =>
      requeueReadyDocuments(tx, mine.organizationId, '', 10)
    )

    expect(queued).toEqual([])
    const theirRow = await withOrganization(owner.db, theirs.organizationId, (tx) =>
      tx.execute<{ state: string }>(sql`select state from playbook.documents where id = ${theirId}`)
    )
    expect(theirRow.rows[0]?.state).toBe('ready')
  })
})
