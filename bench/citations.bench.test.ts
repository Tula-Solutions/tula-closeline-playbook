import { expect, test } from 'bun:test'
import {
  callSchema,
  documentSchema,
  MAX_CITATION_REFS,
  resolveCitationsResponseSchema,
} from 'tula-closeline-contract'
import { createCallHarness } from '../src/modules/call/test-support'
import { measure, summary } from './measure'

// Resolving Citations: one Postgres transaction with one statement per kind over at most 20 ids,
// then one vector lookup by attributes for each distinct Moment or document passage (at most 20,
// run together), then an in-order answer. Complexity: O(refs), at most 20; nothing grows with the
// Organization's size. The vector store and database here are the in-memory doubles, so this
// measures the route and service layer (parse, orchestration, eligibility, response validation)
// with a full 20-reference request (10 Moments, 10 documents), not the network (the real-adapter
// p95 is measured in the phase load test). Typical: measured 0.38 ms a request
// locally). Budget: 2 ms per request (about 5x), the best of 5 batches of 100 requests after a 50-request
// warm-up.
const BUDGET_MS = 2
const EACH = MAX_CITATION_REFS / 2

test(`Resolving ${MAX_CITATION_REFS} Citations: the best batch averages within ${BUDGET_MS} ms a request`, async () => {
  const h = await createCallHarness()
  const refs: unknown[] = []
  for (let i = 0; i < EACH; i++) {
    const text = `Alex: Hello there.\nSam: We worry about the price number ${i}\nAlex: We can cut onboarding with plan ${i}\n`
    const call = callSchema.parse(
      await (await h.uploadCall(text, { dealId: `DEAL-${i}`, as: h.people.owner })).json()
    )
    refs.push({ kind: 'moment', callId: call.id, dealRecordId: call.dealRecordId })
    const document = documentSchema.parse(
      await (
        await h.upload(`doc-${i}.txt`, new TextEncoder().encode(`The onboarding price ${i} is low`))
      ).json()
    )
    refs.push({ kind: 'document', documentId: document.id, page: null })
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

  let available = 0
  const result = await measure(
    async () => {
      const response = await h.send('POST', '/v1/playbook/citations/resolve', { body: { refs } })
      available = resolveCitationsResponseSchema
        .parse(await response.json())
        .items.filter((item) => item.state === 'available').length
    },
    { warmup: 50, batchRequests: 100, batches: 5 }
  )

  console.log(summary('resolve citations', result))
  expect(available).toBe(MAX_CITATION_REFS)
  expect(result.bestMs / result.batchRequests).toBeLessThan(BUDGET_MS)
}, 120_000)
