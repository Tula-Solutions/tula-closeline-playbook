import { expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { createTestDeps } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The pattern every benchmark follows: one operation, a stated batch size, an asserted budget.
// `measure` runs several batches after a warm-up and the test gates on the fastest, so one
// stalled batch (a cold or contended CI runner) cannot fail the gate; a real regression slows
// every batch and does. The budget is about five times the typical best batch.
// Typical best batch: 3.2 ms for 500 requests (about 0.0065 ms each).
// Budget: 5x, rounded up. A regression of about 0.03 ms per request (a stray await, a
// per-request allocation) fails.
const BUDGET_MS = 16

test(`/healthz: the best of ${BATCHES} batches of ${BATCH_REQUESTS} requests is within ${BUDGET_MS} ms`, async () => {
  const app = createApp(createTestDeps())

  const result = await measure(() => app.request('/healthz'))

  console.log(summary('healthz', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
