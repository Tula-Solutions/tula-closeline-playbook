import { expect, test } from 'bun:test'
import { AppError } from 'tula-closeline-kit'
import { createBaseApp } from '../src/http/base'
import { createTestDeps } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The cost every request pays before a module's code runs: request id middleware, the error
// guard, the body limit, the router and the error handler. Complexity is O(1) per request; the
// inputs are fixed. Each test gates on the fastest of several batches (see `measure`), so one
// stalled batch cannot fail it, and each budget is about five times the typical best batch, so a
// regression of a few tens of microseconds per request fails.
// Typical best batch: 2.6 ms for 500 requests (about 0.005 ms each). Budget: 5x, rounded up.
const SUCCESS_BUDGET_MS = 13
// Typical best batch: 4.3 ms for 500 requests (about 0.0085 ms each). Budget: 5x, rounded up.
const ERROR_BUDGET_MS = 22

function build() {
  const app = createBaseApp(createTestDeps())
  app.get('/ok', (c) => c.json({ ok: true }))
  app.get('/fail', () => {
    throw new AppError({ code: 'bench.failed', status: 409, message: 'Failed.' })
  })
  return app
}

test(`success: the best of ${BATCHES} batches of ${BATCH_REQUESTS} requests is within ${SUCCESS_BUDGET_MS} ms`, async () => {
  const app = build()
  const inbound = { 'x-request-id': `req_${'a'.repeat(32)}` }

  const result = await measure((index) =>
    app.request('/ok', index % 2 === 0 ? { headers: inbound } : undefined)
  )

  console.log(summary('middleware (success)', result))
  expect(result.bestMs).toBeLessThan(SUCCESS_BUDGET_MS)
})

test(`error: the best of ${BATCHES} batches of ${BATCH_REQUESTS} requests is within ${ERROR_BUDGET_MS} ms`, async () => {
  const app = build()

  const result = await measure(() => app.request('/fail'))

  console.log(summary('middleware (error)', result))
  expect(result.bestMs).toBeLessThan(ERROR_BUDGET_MS)
})
