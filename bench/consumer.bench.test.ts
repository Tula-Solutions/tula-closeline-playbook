import { expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createMemoryProcessedStore } from 'tula-closeline-kit'
import { createPlaybookConsumer } from '../src/consumer'
import { registry } from '../src/messages'
import { createTestDeps } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The ingestion claim: one message published, received, claimed in the processed store, handled,
// completed and acknowledged, over the memory queue and the memory store. Complexity is O(1) per
// message in the store; the memory queue scans what it holds, which stays one message here. The
// Postgres store adds one statement per step, which only its integration suite can show.
// Typical best batch: 9 ms for 500 messages (about 0.018 ms each). Budget: 5x, rounded up.
const BUDGET_MS = 45

test(`ingestion claim: the best of ${BATCHES} batches of ${BATCH_REQUESTS} messages is within ${BUDGET_MS} ms`, async () => {
  let handled = 0
  const deps = createTestDeps()
  // The kit's memory store: the Postgres one runs its statements on the database double here,
  // whose transactions copy all state, which would time the double and not the claim.
  const consumer = createPlaybookConsumer({
    queue: deps.queue,
    store: createMemoryProcessedStore({ clock: deps.time.clock }),
    logger: deps.logger,
    errorReporter: deps.errors,
    handlers: {
      'playbook.document_uploaded': async () => {
        handled++
      },
    },
    concurrency: deps.env.CONSUMER_CONCURRENCY,
    sleep: deps.time.sleep,
  })
  const organizationId = formatId('org', crypto.randomUUID())
  const traceId = formatId('req', crypto.randomUUID())

  const result = await measure(async () => {
    await deps.queue.publish(
      registry.create({
        type: 'playbook.document_uploaded',
        organizationId,
        traceId,
        payload: { documentId: formatId('doc', crypto.randomUUID()) },
      })
    )
    await consumer.pollOnce()
  })

  console.log(summary('ingestion claim', result))
  expect(handled).toBeGreaterThan(0)
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})

// The same claim through the Postgres store and the removed-Organization guard, over the database
// double. Each consumed message costs one extra indexed read (`ORGANIZATION_REMOVAL_STATUS`, the
// guard's check) and the store's claim and complete statements; the double copies its state for
// every transaction, so the batch is small and the figure is a ceiling for the statement count, not
// for Postgres. Typical best batch: 8 ms for 50 messages (about 0.16 ms each). Budget: 5x, rounded up.
const GUARDED_BUDGET_MS = 40

test(`ingestion claim with the removed-Organization guard: the best of batches of 50 messages is within ${GUARDED_BUDGET_MS} ms`, async () => {
  let handled = 0
  const deps = createTestDeps({
    handlers: {
      'playbook.document_uploaded': async () => {
        handled++
      },
    },
  })
  const organizationId = formatId('org', crypto.randomUUID())
  const traceId = formatId('req', crypto.randomUUID())
  // An Organization with no data reads as removed, and its messages are acknowledged unrecorded.
  deps.database.seed({ id: formatId('doc', crypto.randomUUID()), organization_id: organizationId })

  const result = await measure(
    async () => {
      await deps.queue.publish(
        registry.create({
          type: 'playbook.document_uploaded',
          organizationId,
          traceId,
          payload: { documentId: formatId('doc', crypto.randomUUID()) },
        })
      )
      await deps.consumer.pollOnce()
    },
    { warmup: 20, batchRequests: 50, batches: 5 }
  )

  console.log(summary('ingestion claim (guarded, database double)', result))
  expect(handled).toBeGreaterThan(0)
  expect(result.bestMs).toBeLessThan(GUARDED_BUDGET_MS)
}, 60_000)
