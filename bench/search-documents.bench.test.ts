import { expect, test } from 'bun:test'
import { MAX_SEARCH_CANDIDATES, searchDocumentsResponseSchema } from 'tula-closeline-contract'
import { createDocumentHarness } from '../src/modules/document/test-support'
import { measure, summary } from './measure'

// Search over Playbook documents: embed the query once, one vector search for min(100, limit x 5)
// chunks, one Postgres statement for at most 100 document ids, then a filter and a cut.
// Complexity: O(query length) + O(candidates); nothing grows with the Organization's size. The
// embedder, vector store and database here are the in-memory doubles, so this measures the route
// and service layer with a full 100-document candidate window, not the network (the real-adapter
// p95 is measured in the phase load test). Typical: see the log line (about 0.7 ms a search
// locally). Budget: 5 ms per search, the best of 5 batches of 100 searches after a 50-search warm-up.
const BUDGET_MS = 5
const DOCUMENTS = 100
const TEXT = 'The onboarding price is forty dollars per seat per month for teams of ten or more'

test(`Document search with a ${MAX_SEARCH_CANDIDATES}-document candidate window: the best batch averages within ${BUDGET_MS} ms a search`, async () => {
  const h = await createDocumentHarness()
  for (let i = 0; i < DOCUMENTS; i++) {
    const response = await h.upload(
      `doc-${i}.txt`,
      new TextEncoder().encode(`${TEXT} variant number ${i}`)
    )
    expect(response.status).toBe(201)
  }
  for (let pass = 0; pass < 200; pass++) {
    await h.deps.workers.ingestion.runPass()
    h.deps.time.advance(60_000)
  }

  let found = 0
  const result = await measure(
    async () => {
      const response = await h.app.request('/v1/playbook/search/documents', {
        method: 'POST',
        headers: { ...(await h.bearer(h.people.owner)), 'content-type': 'application/json' },
        body: JSON.stringify({ turns: [{ role: 'prospect', text: TEXT }], limit: 20 }),
      })
      found = searchDocumentsResponseSchema.parse(await response.json()).items.length
    },
    { warmup: 50, batchRequests: 100, batches: 5 }
  )

  console.log(summary('document search', result))
  expect(found).toBe(20)
  expect(result.bestMs / result.batchRequests).toBeLessThan(BUDGET_MS)
}, 120_000)
