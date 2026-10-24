// Runs the Suggestion path against the compose Postgres (`bun run test:integration`): proposal from
// an Agent Call's real `origin` column, accept and reject through the db library's real statements,
// the learning switch, the row-level security scope and the weighting in a search. Objects, vectors,
// the embedder, the phraser and the queue stay in memory.

import { afterAll, describe, expect, test } from 'bun:test'
import {
  CURRENT_RIGHTS_WORDING_VERSION,
  callSchema,
  listSuggestionsResponseSchema,
  searchMomentsResponseSchema,
  suggestionSchema,
} from 'tula-closeline-contract'
import { createDb, RIGHTS_CONFIRM } from 'tula-closeline-db'
import { scopeOver, statementOf } from '~/adapters/postgres/processed-store'
import { integrationUrls } from '~/integration-support'
import { type CallHarness, createCallHarness } from '~/modules/call/test-support'
import { proposeFromWonDeal } from '~/modules/suggestion/propose'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
afterAll(async () => {
  await Promise.allSettled([service.close(), owner.close()])
})

const SUGGESTIONS = '/v1/playbook/suggestions'
const PRICE = 'We are worried about the price of onboarding for the whole team'
const QUERY = { turns: [{ role: 'prospect', text: 'worried about the price of onboarding' }] }

async function harness(): Promise<CallHarness> {
  const h = await createCallHarness({ scope: scopeOver(service.db) })
  await h.deps.scope(h.organizationId, (run) =>
    run(RIGHTS_CONFIRM, [h.organizationId, h.people.owner.userId, CURRENT_RIGHTS_WORDING_VERSION])
  )
  return h
}

async function call(h: CallHarness, method: string, path: string, body?: unknown) {
  return h.app.request(path, {
    method,
    headers: {
      ...(await h.bearer(h.people.owner)),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** Uploads an Agent Call for a Deal, marks its origin in Postgres, wins the Deal and settles. */
async function agentWin(h: CallHarness, dealId: string): Promise<string> {
  const text = `Alex: Hello.\nSam: ${PRICE}\nAlex: We can cut onboarding in half with a guided plan\n`
  const upload = await h.uploadCall(text, { dealId })
  expect(upload.status).toBe(201)
  const created = callSchema.parse(await upload.json())
  await h.runCalls()
  // The service login has no UPDATE on `calls`; only the owner can mark an Agent Call here.
  await owner.db.transaction(async (tx) => {
    await tx.execute(
      statementOf("select set_config('app.organization_id', $1, true)", [h.organizationId])
    )
    await tx.execute(
      statementOf('update playbook.calls set origin = $1 where id = $2', ['agent', created.id])
    )
  })
  await h.setOutcome(created.dealRecordId, 'won')
  for (let pass = 0; pass < 50; pass++) {
    const jobs = await h.deps.workers.ingestion.runPass()
    const messages = await h.deps.consumer.pollOnce()
    if (jobs === 0 && messages === 0) {
      break
    }
  }
  // The test consumer runs over the memory database, so the queue handler is covered by the unit suite; here the proposal runs against Postgres directly.
  await proposeFromWonDeal(
    h.deps,
    h.organizationId,
    created.dealRecordId,
    new AbortController().signal
  )
  return created.id
}

describe('Suggestions against Postgres', () => {
  test('a won Deal of an Agent Call proposes; accept makes it searchable; a second Organization sees nothing', async () => {
    const h = await harness()
    const other = await harness()
    const callId = await agentWin(h, 'AG-1')

    const listed = listSuggestionsResponseSchema.parse(
      await (await call(h, 'GET', SUGGESTIONS)).json()
    )
    expect(listed.items).toHaveLength(1)
    const id = listed.items[0]?.id ?? ''
    expect(String(listed.items[0]?.provenance.moments[0]?.callId)).toBe(callId)
    const accepted = await call(h, 'POST', `${SUGGESTIONS}/${id}/accept`, {})
    expect(accepted.status).toBe(200)
    expect(suggestionSchema.parse(await accepted.json()).status).toBe('accepted')
    expect((await call(h, 'POST', `${SUGGESTIONS}/${id}/accept`, {})).status).toBe(409)

    const found = searchMomentsResponseSchema.parse(
      await (await call(h, 'POST', '/v1/playbook/search/moments', QUERY)).json()
    )
    expect(found.suggestions.map((s) => s.suggestionId)).toEqual([id as never])
    expect(found.items[0]?.origin).toBe('agent')
    expect((await call(other, 'GET', `${SUGGESTIONS}/${id}`)).status).toBe(404)
  })

  test('the learning switch off drops Agent Moments and accepted Suggestions from a search', async () => {
    const h = await harness()
    await agentWin(h, 'AG-2')
    const [first] = listSuggestionsResponseSchema.parse(
      await (await call(h, 'GET', SUGGESTIONS)).json()
    ).items
    await call(h, 'POST', `${SUGGESTIONS}/${first?.id}/accept`, {})
    const off = await call(h, 'PUT', '/v1/playbook/settings/learning', {
      learnFromAgentMoments: false,
    })
    expect(off.status).toBe(200)

    const found = searchMomentsResponseSchema.parse(
      await (await call(h, 'POST', '/v1/playbook/search/moments', QUERY)).json()
    )

    expect(found.items).toEqual([])
    expect(found.suggestions).toEqual([])
  })
})
