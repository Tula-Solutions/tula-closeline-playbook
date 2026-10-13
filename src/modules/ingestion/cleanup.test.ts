import { describe, expect, spyOn, test } from 'bun:test'
import { registry } from '~/messages'
import * as Documents from '~/modules/document/service'
import { cleanupDeletion } from './cleanup'
import { createPipelineHarness, paragraphs } from './test-support'

describe('the vector cleanup of a deleted document', () => {
  test('a delete message removes that document vectors only, and records it', async () => {
    const h = createPipelineHarness()
    const keep = await h.upload('keep.txt', paragraphs(2, 'keep'))
    const gone = await h.upload('gone.txt', paragraphs(2, 'gone'))
    await h.pass()
    await Documents.remove(h.deps, h.context, gone)

    await h.deps.consumer.pollOnce()

    expect(await h.vectorIds(gone)).toEqual([])
    expect((await h.vectorIds(keep)).length).toBeGreaterThan(0)
    expect(h.document(gone)?.vectors_removed_seq).toBe(1)
  })

  test('a message delivered twice cleans once', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('gone.txt', paragraphs(2))
    await h.pass()
    const publish = spyOn(h.deps.queue, 'publish')
    await Documents.remove(h.deps, h.context, id)
    const envelope = publish.mock.calls.at(-1)?.[0]
    if (envelope === undefined) {
      throw new Error('the delete published nothing')
    }
    // The queue is allowed to deliver one message twice.
    await h.deps.queue.publish(envelope)
    const deleteByFilter = spyOn(h.deps.vectors, 'deleteByFilter')

    await h.deps.consumer.pollOnce()
    await h.deps.time.advance(10 * 60 * 1000)
    await h.deps.consumer.pollOnce()

    // Epochs 0 and 1 once: two filters, not four.
    expect(deleteByFilter).toHaveBeenCalledTimes(2)
    expect(h.deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('a message for an older deletion does nothing; the current one cleans', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    await Documents.restore(h.deps, h.context, id)
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    expect(h.document(id)).toMatchObject({ deletion_seq: 2, epoch: 3 })
    const deleteByFilter = spyOn(h.deps.vectors, 'deleteByFilter')

    // Two messages are queued: deletion 1 (outdated) and deletion 2.
    await h.deps.consumer.pollOnce()

    expect(h.document(id)?.vectors_removed_seq).toBe(2)
    // Only deletion 2 asked the store to delete: epochs 0 to 3.
    expect(deleteByFilter).toHaveBeenCalledTimes(4)
    expect(await h.vectorIds(id)).toEqual([])
  })

  test('a message for a document that is gone is acknowledged, not retried', async () => {
    const h = createPipelineHarness()
    await h.upload('other.txt', paragraphs(1))
    await h.deps.queue.publish(
      registry.create({
        type: 'playbook.document_deleted',
        organizationId: h.organizationId,
        traceId: 'req_0123456789abcdef0123456789abcdef',
        payload: { documentId: 'doc_ffffffffffffffffffffffffffffffff', deletionSeq: 1 },
      })
    )
    const deleteByFilter = spyOn(h.deps.vectors, 'deleteByFilter')

    await h.deps.consumer.pollOnce()

    expect(deleteByFilter).not.toHaveBeenCalled()
    expect(h.deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('a delete that must wait for a lease does not hold the consumer slot or report an error; the sweep finishes it', async () => {
    const h = createPipelineHarness({ consumerConcurrency: 1 })
    let release: () => void = () => undefined
    const open = new Promise<void>((resolve) => {
      release = resolve
    })
    spyOn(h.deps.parser, 'parse').mockImplementation(async () => {
      await open
      return { pages: [{ number: 1, text: paragraphs(1), needsOcr: false }] }
    })
    const id = await h.upload('notes.txt', 'x')
    const pass = h.deps.workers.ingestion.runPass()
    await h.deps.time.settle()
    await Documents.remove(h.deps, h.context, id)
    // An unrelated deletion queued behind it in the single slot.
    spyOn(h.deps.parser, 'parse').mockRestore()
    const other = await h.upload('other.txt', paragraphs(2, 'other'))
    await h.pass()
    await Documents.remove(h.deps, h.context, other)

    // Every message in the queue is handled within a second of virtual time, one slot or not.
    const polling = (async () => {
      for (let round = 0; round < 8; round++) {
        await h.deps.consumer.pollOnce()
      }
    })()
    await h.deps.time.advance(1_000)
    await polling
    expect(h.document(other)?.vectors_removed_seq).toBe(1)
    expect(h.document(id)?.vectors_removed_seq).toBeNull()
    expect(h.deps.reported).toEqual([])
    expect(h.deps.errors.captured?.length ?? 0).toBe(0)

    release()
    await h.deps.time.advance(100_000)
    await pass
    await h.deps.time.advance(6 * 60 * 1000)
    await h.deps.workers.sweeps.run('cleanup')
    expect(h.document(id)?.vectors_removed_seq).toBe(1)
  })

  test('a delete message lost in the queue is still cleaned by the sweep, once it is five minutes old', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    for (const delivery of await h.deps.queue.receive({
      maxMessages: 10,
      visibilityTimeoutSeconds: 30,
      waitSeconds: 0,
    })) {
      await h.deps.queue.acknowledge(delivery.receipt)
    }
    await h.deps.workers.sweeps.run('cleanup')
    expect((await h.vectorIds(id)).length).toBeGreaterThan(0)

    await h.deps.time.advance(6 * 60 * 1000)
    await h.deps.workers.sweeps.run('cleanup')

    expect(await h.vectorIds(id)).toEqual([])
    expect(h.document(id)?.vectors_removed_seq).toBe(1)
    expect(h.deps.database.discoveries.map((d) => d.kind)).toContain('cleanup_pending')
  })

  test('the sweep does not visit an Organization whose deletions are all recorded as cleaned (discovery names none)', async () => {
    const h = createPipelineHarness()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(await h.upload(`n${i}.txt`, paragraphs(2, `d${i}`)))
    }
    await h.pass()
    for (const id of ids) {
      await Documents.remove(h.deps, h.context, id)
    }
    for (let round = 0; round < 3; round++) {
      await h.deps.consumer.pollOnce()
    }
    expect(ids.map((id) => h.document(id)?.vectors_removed_seq)).toEqual([1, 1, 1])
    await h.deps.time.advance(10 * 60 * 1000)
    const del = spyOn(h.deps.vectors, 'deleteByFilter')

    await h.deps.workers.sweeps.run('cleanup')

    expect(del).not.toHaveBeenCalled()
  })

  test("one Organization's cleanup never touches another's vectors, even for the same document id", async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))
    await h.pass()
    const stranger = h.other().organizationId
    h.deps.database.seed({ id, organization_id: stranger })
    await h.deps.vectors.upsert(stranger, [
      {
        id: `${id}:0:0`,
        vector: Array.from({ length: 64 }, () => 1),
        attributes: { document_id: id, epoch: 0, chunk: 0, page: 1 },
      },
    ])
    await Documents.remove(h.deps, h.context, id)

    await h.deps.consumer.pollOnce()

    expect(await h.vectorIds(id)).toEqual([])
    expect(await h.vectorIds(id, stranger)).toEqual([`${id}:0:0`])
  })
})

describe('the cleanup_pending sweep scans for a lost cleanup', () => {
  test('reaches a lost cleanup behind 100 newer deleted documents, whether theirs were recorded fast or slowly', async () => {
    const h = createPipelineHarness()
    const never = new AbortController().signal
    // Created one millisecond apart, so the newest-first listing order is the creation order.
    const fast = await h.upload('fast.txt', paragraphs(1, 'fast'))
    await h.deps.time.advance(1)
    const lost = await h.upload('lost.txt', paragraphs(2, 'lost'))
    const others: string[] = []
    for (let i = 0; i < 100; i++) {
      await h.deps.time.advance(1)
      others.push(await h.upload(`n${i}.txt`, paragraphs(1, `d${i}`)))
    }
    for (const id of [fast, lost, ...others]) {
      await Documents.remove(h.deps, h.context, id)
    }
    // One cleanup is recorded 200 ms after its delete, the rest more than a second after.
    await h.deps.time.advance(200)
    await cleanupDeletion(h.deps, h.organizationId, fast, 1, never)
    await h.deps.time.advance(2_000)
    for (const id of others) {
      await cleanupDeletion(h.deps, h.organizationId, id, 1, never)
    }
    expect(h.document(lost)?.vectors_removed_seq).toBeNull()
    await h.deps.time.advance(6 * 60 * 1000)
    const old = await h.deps.vectors.upsert(h.organizationId, [
      {
        id: `${lost}:1:0`,
        vector: Array.from({ length: h.deps.embedder.dimensions }, () => 0.5),
        attributes: { document_id: lost, epoch: 1, chunk: 0, page: 1 },
      },
    ])
    expect(old).toBeUndefined()

    await h.deps.workers.sweeps.run('cleanup')

    expect(h.document(lost)?.vectors_removed_seq).toBe(1)
    expect(await h.vectorIds(lost)).toEqual([])
  })
})
