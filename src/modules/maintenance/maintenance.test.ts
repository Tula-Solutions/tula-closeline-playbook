import { describe, expect, spyOn, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { ORGANIZATIONS_WITH_WORK } from 'tula-closeline-db'
import { registry } from '~/messages'
import * as Documents from '~/modules/document/service'
import { createPipelineHarness, logged, paragraphs } from '~/modules/ingestion/test-support'
import { sweepOrphanObjects } from './housekeeping'

const DAY = 24 * 60 * 60 * 1000
const never = new AbortController().signal

describe('the purge sweep', () => {
  test('removes the file, the pipeline files, the vectors and the row of a document past retention', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    // Not due yet: nothing happens.
    await h.deps.workers.sweeps.run('purge')
    expect(h.document(id)?.state).toBe('deleted')

    await h.deps.time.advance(31 * DAY)
    await h.deps.workers.sweeps.run('purge')

    expect(h.document(id)).toBeUndefined()
    expect(await h.vectorIds(id)).toEqual([])
    expect(
      (await h.deps.objects.list(h.organizationId, { prefix: `documents/${id}/` })).items
    ).toEqual([])
    expect(h.deps.database.discoveries.map((d) => d.kind)).toContain('purge_due')
  })

  test('never purges a document that was restored in time', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    await Documents.restore(h.deps, h.context, id)
    await h.pass()

    await h.deps.time.advance(31 * DAY)
    await h.deps.workers.sweeps.run('purge')

    expect(h.document(id)?.state).toBe('ready')
    expect((await h.vectorIds(id)).length).toBeGreaterThan(0)
    expect(
      (await h.deps.objects.list(h.organizationId, { prefix: `documents/${id}/` })).items.length
    ).toBeGreaterThan(0)
  })

  test('once a purge has started the document can no longer be restored, even if the file could not be removed', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    await h.deps.time.advance(31 * DAY)
    const failing = spyOn(h.deps.objects, 'delete').mockRejectedValue(new Error('storage is down'))

    await h.deps.workers.sweeps.run('purge')

    expect(h.deps.reported).toHaveLength(1)
    expect(h.document(id)?.state).toBe('deleted')
    await expect(Documents.restore(h.deps, h.context, id)).rejects.toMatchObject({
      code: 'document.not_restorable',
    })
    // The lease runs out and the next sweep finishes the job.
    failing.mockRestore()
    await h.deps.time.advance(3 * 60 * 1000)
    await h.deps.workers.sweeps.run('purge')
    expect(h.document(id)).toBeUndefined()
  })

  test('runs the vector cleanup first when its message was lost', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    await h.deps.time.advance(31 * DAY)
    expect(h.document(id)?.vectors_removed_seq).toBeNull()

    await h.deps.workers.sweeps.run('purge')

    expect(await h.vectorIds(id)).toEqual([])
    expect(h.document(id)).toBeUndefined()
  })

  test("erasure waits for a running job's lease, then removes everything, and remove-all answers 200", async () => {
    const h = createPipelineHarness()
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
    const requestId = formatId('req', crypto.randomUUID())
    await expect(
      Documents.removeAll(h.deps, h.organizationId, requestId, 'erase-1')
    ).rejects.toMatchObject({ code: 'server.unavailable' })

    // The job may still hold its lease: the purge defers, and no vector is written meanwhile.
    await h.deps.workers.sweeps.run('purge')
    expect(h.document(id)?.state).toBe('deleted')
    release()
    await h.deps.time.advance(130_000)
    await pass
    await h.deps.workers.sweeps.run('purge')

    expect(h.document(id)).toBeUndefined()
    expect(await h.vectorIds(id)).toEqual([])
    await expect(
      Documents.removeAll(h.deps, h.organizationId, requestId, 'erase-1')
    ).resolves.toMatchObject({ status: 'removed' })
  })

  test('a document that cannot be purged in twenty attempts is listed for a person and never claimed again', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    await h.deps.time.advance(31 * DAY)
    spyOn(h.deps.objects, 'delete').mockRejectedValue(new Error('storage is down'))
    for (let attempt = 0; attempt < 20; attempt++) {
      await h.deps.workers.sweeps.run('purge')
      await h.deps.time.advance(3 * 60 * 1000)
    }
    expect(h.document(id)?.purge_attempts).toBe(20)
    const reportedBefore = h.deps.reported.length

    await h.deps.workers.sweeps.run('purge')
    await h.deps.workers.sweeps.run('housekeeping')

    expect(h.deps.reported.length).toBe(reportedBefore)
    expect(h.document(id)?.purge_attempts).toBe(20)
    const lines = logged(h.deps, 'purges have given up and need a person')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ documents: [id], organizationId: h.organizationId })
  })
})

describe('the orphan object sweep', () => {
  test('deletes an old object no document names, and nothing else', async () => {
    const h = createPipelineHarness()
    const known = await h.upload('notes.txt', paragraphs(2))
    const orphan = `documents/doc_${'a'.repeat(32)}/original.pdf`
    await h.deps.objects.put(h.organizationId, orphan, new Uint8Array([1]))
    await h.deps.objects.put(h.organizationId, 'elsewhere/keep.bin', new Uint8Array([1]))
    await h.deps.time.advance(25 * 60 * 60 * 1000)
    const young = `documents/doc_${'b'.repeat(32)}/original.pdf`
    await h.deps.objects.put(h.organizationId, young, new Uint8Array([1]))

    const deleted = await sweepOrphanObjects(h.deps, h.organizationId, never)

    expect(deleted).toBe(1)
    const keys = (await h.deps.objects.list(h.organizationId)).items.map((i) => i.key)
    expect(keys).toContain(young)
    expect(keys).toContain('elsewhere/keep.bin')
    expect(keys).toContain(`documents/${known}/original.txt`)
    expect(keys).not.toContain(orphan)
  })

  test('a young object is kept however unreferenced: an upload may be about to name it', async () => {
    const h = createPipelineHarness()
    const young = `documents/doc_${'c'.repeat(32)}/original.pdf`
    await h.deps.objects.put(h.organizationId, young, new Uint8Array([1]))
    await h.deps.time.advance(23 * 60 * 60 * 1000)

    expect(await sweepOrphanObjects(h.deps, h.organizationId, never)).toBe(0)
  })

  test('reads the listing a page at a time and still finds an orphan on a later page', async () => {
    const h = createPipelineHarness({ env: { ORPHAN_PAGE_SIZE: '2' } })
    for (let i = 0; i < 5; i++) {
      await h.deps.objects.put(
        h.organizationId,
        `documents/doc_${String(i).repeat(32)}/original.pdf`,
        new Uint8Array([1])
      )
    }
    await h.deps.time.advance(25 * 60 * 60 * 1000)
    const list = spyOn(h.deps.objects, 'list')

    expect(await sweepOrphanObjects(h.deps, h.organizationId, never)).toBe(5)
    expect(list.mock.calls.length).toBeGreaterThan(1)
    expect(list.mock.calls.every(([, options]) => (options?.limit ?? 0) <= 2)).toBe(true)
  })

  test('the housekeeping sweep finds an Organization through its idempotency keys and cleans it', async () => {
    const h = createPipelineHarness()
    const orphan = `documents/doc_${'d'.repeat(32)}/original.pdf`
    await h.deps.objects.put(h.organizationId, orphan, new Uint8Array([1]))
    await h.upload('notes.txt', paragraphs(2), { key: 'upload-1' })
    await h.deps.time.advance(25 * 60 * 60 * 1000)
    expect(h.deps.database.keys(h.organizationId)).toHaveLength(1)

    await h.deps.workers.sweeps.run('housekeeping')

    expect(await h.deps.objects.head(h.organizationId, orphan)).toBeUndefined()
    expect(h.deps.database.keys(h.organizationId)).toEqual([])
  })
})

describe('housekeeping of consumed messages', () => {
  test('purges done records after fifteen days, the global scope included, and keeps the young', async () => {
    const h = createPipelineHarness()
    await h.upload('notes.txt', paragraphs(2))
    await h.deps.consumer.pollOnce()
    expect(h.deps.database.consumed(h.organizationId)).toHaveLength(1)
    const key = { consumer: 'playbook.ingestion', organizationId: null, messageId: 'global-1' }
    const claim = await h.deps.processed.claim(key, 60)
    if (claim.status !== 'claimed') {
      throw new Error('expected a claim')
    }
    await h.deps.processed.complete(key, claim.token)

    await h.deps.time.advance(10 * DAY)
    await h.deps.workers.sweeps.run('housekeeping')
    expect(h.deps.database.consumed(h.organizationId)).toHaveLength(1)

    await h.deps.time.advance(6 * DAY)
    await h.deps.workers.sweeps.run('housekeeping')

    expect(h.deps.database.consumed(h.organizationId)).toEqual([])
    expect(h.deps.database.consumed(`org_${'0'.repeat(32)}`)).toEqual([])
  })
})

describe('messages of a removed Organization', () => {
  test('are acknowledged without a record, so the Organization can read as removed', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))
    await h.pass()
    const requestId = formatId('req', crypto.randomUUID())
    await expect(
      Documents.removeAll(h.deps, h.organizationId, requestId, 'bye')
    ).rejects.toBeDefined()
    await h.deps.workers.sweeps.run('cleanup')
    await h.deps.workers.sweeps.run('purge')
    await Documents.removeAll(h.deps, h.organizationId, requestId, 'bye')
    expect(h.document(id)).toBeUndefined()

    // A late message for the removed Organization arrives.
    await h.deps.queue.publish(
      registry.create({
        type: 'playbook.document_deleted',
        organizationId: h.organizationId,
        traceId: 'req_0123456789abcdef0123456789abcdef',
        payload: { documentId: id, deletionSeq: 1 },
      })
    )
    await h.deps.consumer.pollOnce()

    expect(h.deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
    expect(h.deps.database.consumed(h.organizationId)).toEqual([])
    const status = await h.deps.scope(h.organizationId, (run) =>
      run('select not exists (select 1) as no_documents', []).catch(() => ({
        rows: [],
        rowCount: 0,
      }))
    )
    expect(status.rows).toEqual([])
  })

  test('a live Organization still gets its messages recorded', async () => {
    const h = createPipelineHarness()
    await h.upload('notes.txt', paragraphs(2))

    await h.deps.consumer.pollOnce()

    expect(h.deps.database.consumed(h.organizationId)).toHaveLength(1)
  })
})

describe('work discovery', () => {
  test('runs unscoped through its own seam, and never inside an Organization transaction', async () => {
    const h = createPipelineHarness()
    await h.upload('notes.txt', paragraphs(2))

    await h.pass()

    expect(new Set(h.deps.database.discoveries.map((d) => d.kind))).toEqual(new Set(['jobs_due']))
    const inside = h.deps.database.transactionStatements.flat()
    expect(inside).not.toContain(ORGANIZATIONS_WITH_WORK)
    await expect(
      h.deps.scope(h.organizationId, (run) => run(ORGANIZATIONS_WITH_WORK, ['jobs_due', '', 10]))
    ).rejects.toMatchObject({ code: '42501' })
  })

  test('pages by resume_after: every Organization with work is served, one per page', async () => {
    const h = createPipelineHarness({ env: { DISCOVERY_BATCH: '1' } })
    const ids: [string, string][] = []
    for (let i = 0; i < 3; i++) {
      const other = h.other()
      const uploaded = await Documents.upload(h.deps, other, {
        fileName: `n${i}.txt`,
        declaredMediaType: null,
        bytes: new TextEncoder().encode(paragraphs(2, `o${i}`)),
        idempotencyKey: undefined,
      })
      ids.push([other.organizationId, uploaded.document.id])
    }

    await h.pass()

    for (const [org, id] of ids) {
      expect(h.deps.database.documents(org).find((d) => d.id === id)?.state).toBe('ready')
    }
    expect(h.deps.database.discoveries.length).toBeGreaterThanOrEqual(4)
  })
})
