import { expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
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
  const deps = createTestDeps({
    handlers: {
      'playbook.document_uploaded': async () => {
        handled++
      },
    },
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
    await deps.consumer.pollOnce()
  })

  console.log(summary('ingestion claim', result))
  expect(handled).toBeGreaterThan(0)
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
