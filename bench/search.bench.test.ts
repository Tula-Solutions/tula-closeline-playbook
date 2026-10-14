import { expect, test } from 'bun:test'
import { MAX_SEARCH_CANDIDATES, searchMomentsResponseSchema } from 'tula-closeline-contract'
import { createCallHarness } from '../src/modules/call/test-support'
import { measure, summary } from './measure'

// Search over won Deals: embed the query once, one vector search for min(100, limit x 5)
// candidates, one Postgres statement for at most 100 Call ids, then a filter and a cut.
// Complexity: O(query length) + O(candidates); nothing grows with the Organization's size. The
// embedder, vector store and database here are the in-memory doubles, so this measures the route
// and service layer (parse, orchestration, eligibility, response validation) with a full 100-Call
// candidate window, not the network (embedding ~400 ms, vector ~150 ms, Postgres ~30 ms are
// measured against the real adapters in the phase load test). Typical: 0.9 ms a search locally. Budget: 5 ms
// per search (about 5x), the best of 5 batches of 100 searches after a 50-search warm-up.
const BUDGET_MS = 5
const CALLS = 100
const TURN = 'We are worried about the price of onboarding for the whole team'

test(`Search with a ${MAX_SEARCH_CANDIDATES}-Call candidate window: the best batch averages within ${BUDGET_MS} ms a search`, async () => {
  const h = await createCallHarness()
  for (let i = 0; i < CALLS; i++) {
    const text = `Alex: Hello there.\nSam: ${TURN} number ${i}\nAlex: We can cut onboarding with plan ${i}\n`
    const response = await h.uploadCall(text, { dealId: `DEAL-${i}`, as: h.people.owner })
    expect(response.status).toBe(201)
  }
  for (let pass = 0; pass < 500 && (await h.deps.workers.ingestion.runPass()) > 0; pass++) {}
  for (const deal of h.deps.database.deals(h.organizationId)) {
    const response = await h.send('PUT', `/v1/playbook/deals/${deal.id}/outcome`, {
      body: { outcome: 'won' },
    })
    expect(response.status).toBe(200)
  }
  for (let pass = 0; pass < 200; pass++) {
    await h.deps.workers.ingestion.runPass()
    h.deps.time.advance(60_000)
  }

  let found = 0
  const result = await measure(
    async () => {
      const response = await h.send('POST', '/v1/playbook/search/moments', {
        body: { turns: [{ role: 'prospect', text: TURN }], limit: 20 },
      })
      found = searchMomentsResponseSchema.parse(await response.json()).items.length
    },
    { warmup: 50, batchRequests: 100, batches: 5 }
  )

  console.log(summary('search', result))
  expect(found).toBe(20)
  expect(result.bestMs / result.batchRequests).toBeLessThan(BUDGET_MS)
}, 120_000)
