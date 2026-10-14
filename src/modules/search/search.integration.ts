// Runs Moment search against the compose Postgres (`bun run test:integration`); it is not part of
// `bun test src`. The unit suite runs the route over a double of the database; this runs the db
// library's real `CALL_SEARCH_STATE` statement (the array parameter, the row-level security scope
// and the Postgres side of the eligibility check). Objects, vectors, the embedder and the queue
// stay in memory.

import { afterAll, describe, expect, test } from 'bun:test'
import {
  type Call,
  CURRENT_RIGHTS_WORDING_VERSION,
  callSchema,
  searchMomentsResponseSchema,
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

const PROSPECT = 'We are worried about the price of onboarding for the whole team'
const QUERY = { turns: [{ role: 'prospect', text: 'worried about the price of onboarding' }] }

/** A harness over the real database, with its own Organization. */
async function harness(): Promise<CallHarness> {
  const h = await createCallHarness({ scope: scopeOver(service.db) })
  h.deps.discover = discover
  await h.deps.scope(h.organizationId, (run) =>
    run(RIGHTS_CONFIRM, [h.organizationId, h.people.owner.userId, CURRENT_RIGHTS_WORDING_VERSION])
  )
  return h
}

/** Uploads a Transcript for a Deal and runs every job (the Outcome re-tag included) to the end. */
async function ready(h: CallHarness, dealId: string, answer: string): Promise<Call> {
  const text = `Alex: Thanks for joining today.\nSam: ${PROSPECT}\nAlex: ${answer}\n`
  const response = await h.uploadCall(text, { dealId })
  expect(response.status).toBe(201)
  const call = callSchema.parse(await response.json())
  for (let pass = 0; pass < 50 && (await h.deps.workers.ingestion.runPass()) > 0; pass++) {}
  return call
}

async function win(h: CallHarness, call: Call): Promise<void> {
  const response = await h.send('PUT', `/v1/playbook/deals/${call.dealRecordId}/outcome`, {
    body: { outcome: 'won' },
  })
  expect(response.status).toBe(200)
  for (let pass = 0; pass < 50 && (await h.deps.workers.ingestion.runPass()) > 0; pass++) {}
}

describe('search against Postgres', () => {
  test('returns the Moment of a won Deal and not those of an open one', async () => {
    const h = await harness()
    const won = await ready(h, 'WON-1', 'We can cut onboarding in half with a guided plan')
    await ready(h, 'OPEN-1', 'Let me send you our pricing sheet today')
    await win(h, won)

    const response = await h.send('POST', '/v1/playbook/search/moments', { body: QUERY })

    expect(response.status).toBe(200)
    const body = searchMomentsResponseSchema.parse(await response.json())
    expect(body.items.map((item) => item.callId)).toEqual([won.id])
    expect(body.evidence).toEqual({ moments: 1, deals: 1 })
    expect(JSON.stringify(body)).not.toContain('WON-1')
  })

  test('a Deal that went from won to lost is dropped before the re-tag has run', async () => {
    const h = await harness()
    const call = await ready(h, 'WON-1', 'We can cut onboarding in half with a guided plan')
    await win(h, call)
    const lost = await h.send('PUT', `/v1/playbook/deals/${call.dealRecordId}/outcome`, {
      body: { outcome: 'lost' },
    })
    expect(lost.status).toBe(200)

    const body = searchMomentsResponseSchema.parse(
      await (await h.send('POST', '/v1/playbook/search/moments', { body: QUERY })).json()
    )

    expect(body.items).toEqual([])
  })

  test("a second Organization's Call id planted in the caller's namespace is never returned", async () => {
    const mine = await harness()
    const theirs = await harness()
    const theirCall = await ready(
      theirs,
      'WON-2',
      'We can cut onboarding in half with a guided plan'
    )
    await win(theirs, theirCall)
    const [vector] = await mine.deps.embedder.embed(
      ['Prospect: worried about the price of onboarding'],
      {
        purpose: 'query',
        signal: new AbortController().signal,
      }
    )
    await mine.deps.vectors.upsert(mine.organizationId, [
      {
        id: 'planted:0',
        vector: vector ?? [],
        attributes: {
          call_id: theirCall.id,
          epoch: 0,
          rep_seq: 0,
          moment: 0,
          outcome: 'won',
          outcome_seq: 1,
          prospect: 'LEAKED-PROSPECT-TEXT',
          rep_next: 'LEAKED-REP-TEXT',
          v: 2,
        },
      },
    ])

    const response = await mine.send('POST', '/v1/playbook/search/moments', { body: QUERY })

    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('LEAKED')
  })
})
