import { expect, test } from 'bun:test'
import { createApp } from '../src/app'

// The pattern every benchmark follows: one operation, a stated input size, an asserted budget.
// Budgets are generous enough for a shared CI runner and tight enough to catch a regression.
const REQUESTS = 2_000
const BUDGET_MS = 1_000

test(`${REQUESTS} health requests complete within ${BUDGET_MS} ms`, async () => {
  const app = createApp()
  const started = performance.now()

  for (let index = 0; index < REQUESTS; index++) {
    await app.request('/healthz')
  }

  const elapsed = performance.now() - started
  console.log(`healthz: ${(elapsed / REQUESTS).toFixed(4)} ms per request`)
  expect(elapsed).toBeLessThan(BUDGET_MS)
})
