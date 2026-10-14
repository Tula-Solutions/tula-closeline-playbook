import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import type { Handlers } from 'tula-closeline-kit/queue'
import { CONSUMER_NAME } from './consumer'
import { type PlaybookEnvelope, registry } from './messages'
import { createTestDeps, newOrganizationId, type TestDeps } from './testing'

const documentId = () => formatId('doc', crypto.randomUUID())
const traceId = formatId('req', crypto.randomUUID())

/** A message for an Organization that exists: it holds a document, as every real one does when a message arrives. */
function uploaded(deps: TestDeps, organizationId = newOrganizationId()) {
  deps.database.seed({ id: documentId(), organization_id: organizationId })
  return registry.create({
    type: 'playbook.document_uploaded',
    organizationId,
    traceId,
    payload: { documentId: documentId() },
  })
}

/** Handlers that note every message they were given, failing the first `failures` times. */
function counting(failures = 0) {
  const seen: { id: string; organizationId: string | undefined }[] = []
  let failed = 0
  const handlers: Handlers<PlaybookEnvelope> = {
    'playbook.document_uploaded': async (message, context) => {
      seen.push({ id: message.id, organizationId: context.organizationId })
      if (failed < failures) {
        failed++
        throw new Error('the parser fell over')
      }
    },
  }
  return { handlers, seen }
}

describe('the queue consumer', () => {
  test('a published message is handled once, in its own Organization, and leaves the queue', async () => {
    const { handlers, seen } = counting()
    const deps = createTestDeps({ handlers })
    const message = uploaded(deps)
    await deps.queue.publish(message)

    expect(await deps.consumer.pollOnce()).toBe(1)

    expect(seen).toEqual([{ id: message.id, organizationId: message.organizationId }])
    expect(deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
    expect(deps.errors.captured).toEqual([])
  })

  test('the same message published twice is handled once', async () => {
    const { handlers, seen } = counting()
    const deps = createTestDeps({ handlers })
    const message = uploaded(deps)
    await deps.queue.publish(message)
    await deps.queue.publish(message)

    await deps.consumer.pollOnce()
    // The second copy met a live claim and was hidden; it is acknowledged when it comes back.
    await deps.time.advance(10 * 60 * 1000)
    await deps.consumer.pollOnce()

    expect(seen).toHaveLength(1)
    expect(deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('a message redelivered after it was handled is acknowledged without running again', async () => {
    const { handlers, seen } = counting()
    const deps = createTestDeps({ handlers })
    const message = uploaded(deps)
    await deps.queue.publish(message)
    await deps.consumer.pollOnce()

    await deps.queue.publish(message)
    await deps.consumer.pollOnce()

    expect(seen).toHaveLength(1)
    expect(deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('a message redelivered while its first run is still going is not run twice', async () => {
    const entered: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const deps = createTestDeps({
      handlers: {
        'playbook.document_uploaded': async (message) => {
          entered.push(message.id)
          await gate
        },
      },
    })
    const message = uploaded(deps)
    await deps.queue.publish(message)
    const first = deps.consumer.pollOnce()
    await deps.time.settle()

    await deps.queue.publish(message)
    await deps.consumer.pollOnce()
    release()
    await first

    expect(entered).toEqual([message.id])
  })

  test('a handler that fails is retried after a delay and then processed', async () => {
    const { handlers, seen } = counting(1)
    const deps = createTestDeps({ handlers })
    const message = uploaded(deps)
    await deps.queue.publish(message)

    await deps.consumer.pollOnce()
    expect(seen).toHaveLength(1)
    expect(deps.queue.depth()).toEqual({ visible: 0, inFlight: 1 })

    expect(await deps.consumer.pollOnce()).toBe(0)
    await deps.time.advance(10 * 60 * 1000)
    await deps.consumer.pollOnce()

    expect(seen).toHaveLength(2)
    expect(deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
    expect(deps.queue.deadLetters()).toEqual([])
  })

  test('a failure is reported without the message payload', async () => {
    const { handlers } = counting(1)
    const deps = createTestDeps({ handlers })
    await deps.queue.publish(uploaded(deps))

    await deps.consumer.pollOnce()

    expect(deps.errors.captured).toHaveLength(1)
    const logged = deps.logLines.join('\n')
    expect(logged).not.toContain('documentId')
  })

  test('a message that always fails ends in the dead-letter list instead of looping for ever', async () => {
    const { handlers, seen } = counting(1_000)
    const deps = createTestDeps({ handlers })
    await deps.queue.publish(uploaded(deps))

    for (let delivery = 0; delivery < 8; delivery++) {
      await deps.consumer.pollOnce()
      await deps.time.advance(10 * 60 * 1000)
    }

    expect(seen.length).toBeLessThanOrEqual(5)
    expect(deps.queue.deadLetters()).toHaveLength(1)
  })

  test('two Organizations sending the same message id are two messages', async () => {
    const { handlers, seen } = counting()
    const deps = createTestDeps({ handlers })
    const first = uploaded(deps)
    const second = { ...first, organizationId: newOrganizationId() }
    deps.database.seed({ id: documentId(), organization_id: second.organizationId })
    await deps.queue.publish(first)
    await deps.queue.publish(second)

    await deps.consumer.pollOnce()

    expect(seen.map((s) => s.organizationId).sort()).toEqual(
      [first.organizationId, second.organizationId].sort()
    )
  })

  test('a message type with no handler is never acknowledged, so it cannot be silently lost', async () => {
    const deps = createTestDeps({ handlers: {} })
    await deps.queue.publish(uploaded(deps))

    await deps.consumer.pollOnce()

    expect(deps.queue.depth().visible + deps.queue.depth().inFlight).toBe(1)
  })

  test('the consumer is named for its idempotency key', () => {
    expect(CONSUMER_NAME).toBe('playbook.ingestion')
  })
})

describe('the Deal Outcome message', () => {
  test('is acknowledged by the default handlers, whatever it carries, until the re-tag job exists', async () => {
    const deps = createTestDeps()
    const organizationId = newOrganizationId()
    const message = registry.create({
      type: 'playbook.deal_outcome_changed',
      organizationId,
      traceId,
      payload: { dealRecordId: formatId('deal', crypto.randomUUID()), outcomeSeq: 3 },
    })
    await deps.queue.publish(message)

    expect(await deps.consumer.pollOnce()).toBe(1)

    expect(deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
    expect(deps.errors.captured).toEqual([])
  })
})
