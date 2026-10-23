// Runs Resolve Citations against the compose Postgres (`bun run test:integration`); it is not part
// of `bun test src`. The unit suite runs the route over a double of the database; this runs the db
// library's real `CALL_SEARCH_STATE` and `DOCUMENT_SEARCH_STATE` statements (the array parameter,
// the row-level security scope and the Postgres side of the eligibility check). Objects, vectors,
// the embedder and the queue stay in memory.

import { afterAll, describe, expect, test } from 'bun:test'
import {
  type Call,
  CURRENT_RIGHTS_WORDING_VERSION,
  callSchema,
  documentSchema,
  resolveCitationsResponseSchema,
} from 'tula-closeline-contract'
import {
  createDb,
  ORGANIZATIONS_WITH_WORK,
  RIGHTS_CONFIRM,
  type WorkDiscoveryRow,
} from 'tula-closeline-db'
import { type Discover, scopeOver, statementOf } from '~/adapters/postgres/processed-store'
import { integrationUrls } from '~/integration-support'
import { type CallHarness, createCallHarness } from '~/modules/call/test-support'

const urls = integrationUrls()
const service = createDb(urls.service)
afterAll(async () => {
  await Promise.allSettled([service.close()])
})

const discover: Discover = (kind, after, batch) =>
  service.db.transaction(async (tx) => {
    const result = await tx.execute(statementOf(ORGANIZATIONS_WITH_WORK, [kind, after, batch]))
    return result.rows as unknown as WorkDiscoveryRow[]
  })

const RESOLVE = '/v1/playbook/citations/resolve'
const PROSPECT = 'We are worried about the price of onboarding for the whole team'
const PRICING = 'Our onboarding price is 40 dollars per seat per month for teams of ten or more'

/** A harness over the real database, with its own Organization. */
async function harness(): Promise<CallHarness> {
  const h = await createCallHarness({ scope: scopeOver(service.db) })
  h.deps.discover = discover
  await h.deps.scope(h.organizationId, (run) =>
    run(RIGHTS_CONFIRM, [h.organizationId, h.people.owner.userId, CURRENT_RIGHTS_WORDING_VERSION])
  )
  return h
}

async function settle(h: CallHarness): Promise<void> {
  for (let pass = 0; pass < 50 && (await h.deps.workers.ingestion.runPass()) > 0; pass++) {}
}

/** A won Deal's processed Call. */
async function wonCall(h: CallHarness, dealId: string): Promise<Call> {
  const text = `Alex: Thanks for joining today.\nSam: ${PROSPECT}\nAlex: We can cut onboarding in half\n`
  const response = await h.uploadCall(text, { dealId })
  expect(response.status).toBe(201)
  const call = callSchema.parse(await response.json())
  await settle(h)
  const won = await h.send('PUT', `/v1/playbook/deals/${call.dealRecordId}/outcome`, {
    body: { outcome: 'won' },
  })
  expect(won.status).toBe(200)
  await settle(h)
  return call
}

async function uploaded(h: CallHarness, name: string): Promise<string> {
  const response = await h.upload(name, new TextEncoder().encode(PRICING))
  expect(response.status).toBe(201)
  const id = documentSchema.parse(await response.json()).id
  await settle(h)
  return id
}

const resolve = async (h: CallHarness, refs: unknown) => {
  const response = await h.send('POST', RESOLVE, { body: { refs } })
  expect(response.status).toBe(200)
  return resolveCitationsResponseSchema.parse(await response.json()).items
}

describe('resolve citations against Postgres', () => {
  test('resolves a Moment and a document passage, in request order', async () => {
    const h = await harness()
    const call = await wonCall(h, 'WON-1')
    const documentId = await uploaded(h, 'pricing.txt')

    const items = await resolve(h, [
      { kind: 'document', documentId, page: null },
      { kind: 'moment', callId: call.id, dealRecordId: call.dealRecordId },
    ])

    expect(items.map((item) => [item.kind, item.state])).toEqual([
      ['document', 'available'],
      ['moment', 'available'],
    ])
  })

  test('a deleted document is removed, not its text', async () => {
    const h = await harness()
    const documentId = await uploaded(h, 'pricing.txt')
    const deleted = await h.send('DELETE', `/v1/playbook/documents/${documentId}`)
    expect(deleted.status).toBeLessThan(300)

    const items = await resolve(h, [{ kind: 'document', documentId, page: null }])

    expect(items.map((item) => item.state)).toEqual(['removed'])
    expect(JSON.stringify(items)).not.toContain('dollars')
  })

  test("another Organization's references are removed", async () => {
    const mine = await harness()
    const theirs = await harness()
    const call = await wonCall(theirs, 'WON-2')
    const documentId = await uploaded(theirs, 'theirs.txt')

    const items = await resolve(mine, [
      { kind: 'document', documentId, page: null },
      { kind: 'moment', callId: call.id, dealRecordId: call.dealRecordId },
    ])

    expect(items.map((item) => item.state)).toEqual(['removed', 'removed'])
    expect(JSON.stringify(items)).not.toContain('dollars')
  })
})
