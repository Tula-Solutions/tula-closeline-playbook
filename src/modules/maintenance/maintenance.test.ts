import { describe, expect, spyOn, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { ORGANIZATIONS_WITH_WORK, ORPHAN_SWEEP_DONE } from 'tula-closeline-db'
import { postgresError } from '~/adapters/memory/playbook-database'
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

  test('an Organization with only a failed upload is visited through the orphan_sweep kind, and marked swept', async () => {
    const h = createPipelineHarness()
    const orphan = `documents/doc_${'d'.repeat(32)}/original.pdf`
    await h.deps.objects.put(h.organizationId, orphan, new Uint8Array([1]))
    await h.upload('notes.txt', paragraphs(2), { key: 'upload-1' })
    const names = async () =>
      (await h.deps.discover('orphan_sweep', '', 100)).map((row) => row.organization_id)
    await h.deps.time.advance(24 * 60 * 60 * 1000)
    expect(await names()).not.toContain(h.organizationId)
    await h.deps.time.advance(61 * 60 * 1000)
    expect(await names()).toContain(h.organizationId)

    await h.deps.workers.sweeps.run('housekeeping')

    expect(await h.deps.objects.head(h.organizationId, orphan)).toBeUndefined()
    expect(h.deps.database.discoveries.map((d) => d.kind)).toContain('orphan_sweep')
    expect(await names()).not.toContain(h.organizationId)
    // The key is kept for 26 hours, an hour past the sweep, then purged.
    expect(h.deps.database.keys(h.organizationId)).toHaveLength(1)
  })

  test('an attempt newer than the sweep keeps the Organization named until its own sweep (more)', async () => {
    const h = createPipelineHarness()
    await h.upload('a.txt', paragraphs(2, 'a'), { key: 'first' })
    await h.deps.time.advance(10 * 60 * 60 * 1000)
    await h.upload('b.txt', paragraphs(2, 'b'), { key: 'second' })
    await h.deps.time.advance(16 * 60 * 60 * 1000)
    const names = async () =>
      (await h.deps.discover('orphan_sweep', '', 100)).map((row) => row.organization_id)

    await h.deps.workers.sweeps.run('housekeeping')

    // The second attempt is 16 hours old: it is not covered, and is named 25 hours after it.
    expect(await names()).not.toContain(h.organizationId)
    await h.deps.time.advance(10 * 60 * 60 * 1000)
    expect(await names()).toContain(h.organizationId)
    const orphan = `documents/doc_${'f'.repeat(32)}/original.pdf`
    await h.deps.objects.put(h.organizationId, orphan, new Uint8Array([1]))
    await h.deps.time.advance(25 * 60 * 60 * 1000)
    await h.deps.workers.sweeps.run('housekeeping')
    expect(await h.deps.objects.head(h.organizationId, orphan)).toBeUndefined()
    expect(await names()).not.toContain(h.organizationId)
  })

  test('a lock timeout on ORPHAN_SWEEP_DONE is tried again next tick, with no error report', async () => {
    const h = createPipelineHarness()
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    await h.deps.time.advance(26 * 60 * 60 * 1000)
    h.deps.database.failAlways(ORPHAN_SWEEP_DONE, postgresError('55P03'))
    const names = async () =>
      (await h.deps.discover('orphan_sweep', '', 100)).map((row) => row.organization_id)

    await h.deps.workers.sweeps.run('housekeeping')
    await h.deps.workers.sweeps.run('housekeeping')

    expect(h.deps.reported).toEqual([])
    expect(await names()).toContain(h.organizationId)
    h.deps.database.clearFailures()
    await h.deps.workers.sweeps.run('housekeeping')
    expect(await names()).not.toContain(h.organizationId)
  })

  test('a listing cut short by the page bound is not marked done', async () => {
    const h = createPipelineHarness({ env: { ORPHAN_PAGE_SIZE: '2', ORPHAN_MAX_PAGES: '1' } })
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    for (let i = 0; i < 6; i++) {
      await h.deps.objects.put(
        h.organizationId,
        `documents/doc_${String(i).repeat(32)}/original.pdf`,
        new Uint8Array([1])
      )
    }
    await h.deps.time.advance(26 * 60 * 60 * 1000)

    await h.deps.workers.sweeps.run('housekeeping')

    // Two objects looked at and deleted; the rest were not examined, so the sweep is not done.
    expect(
      (await h.deps.discover('orphan_sweep', '', 100)).map((row) => row.organization_id)
    ).toContain(h.organizationId)
  })

  test('ORPHAN_SWEEP_DONE gets the time the sweep started, not the time done was called', async () => {
    const h = createPipelineHarness()
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    await h.deps.time.advance(26 * 60 * 60 * 1000)
    const started = h.deps.clock.now().toISOString()
    const seen: unknown[][] = []
    const scope = h.deps.scope
    h.deps.scope = (organizationId, fn) =>
      scope(organizationId, (run) =>
        fn(async (text, params) => {
          if (text === ORPHAN_SWEEP_DONE) {
            seen.push([...params])
          }
          return run(text, params)
        })
      )
    // The listing takes twenty seconds of virtual time (inside the object-store deadline).
    const list = h.deps.objects.list.bind(h.deps.objects)
    spyOn(h.deps.objects, 'list').mockImplementation(async (org, options) => {
      await h.deps.time.advance(20_000)
      return list(org, options)
    })

    await h.deps.workers.sweeps.run('housekeeping')

    expect(seen).toEqual([[h.organizationId, started]])
  })

  test('the idempotency purge keeps a key for 26 hours', async () => {
    const h = createPipelineHarness()
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    await h.deps.time.advance(25 * 60 * 60 * 1000)
    await h.deps.workers.sweeps.run('housekeeping')
    expect(h.deps.database.keys(h.organizationId)).toHaveLength(1)

    await h.deps.time.advance(2 * 60 * 60 * 1000)
    await h.deps.workers.sweeps.run('housekeeping')

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

describe('what discovery counts as due (as the database does)', () => {
  test('a message completed minutes ago and a document deleted today are not due, and are once their time comes', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))
    await h.pass()
    await h.deps.consumer.pollOnce()
    await Documents.remove(h.deps, h.context, id)
    const names = async (kind: 'consumed_purge' | 'purge_due') =>
      (await h.deps.discover(kind, '', 100)).map((row) => row.organization_id)

    expect(await names('consumed_purge')).not.toContain(h.organizationId)
    expect(await names('purge_due')).not.toContain(h.organizationId)

    await h.deps.time.advance(14 * DAY)
    expect(await names('consumed_purge')).not.toContain(h.organizationId)
    await h.deps.time.advance(2 * DAY)
    expect(await names('consumed_purge')).toContain(h.organizationId)
    await h.deps.time.advance(15 * DAY)
    expect(await names('purge_due')).toContain(h.organizationId)
  })
})

describe('a purge removes the vectors of every epoch', () => {
  test('a document restored more than 64 times leaves nothing behind, a vector at epoch 1 included', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))
    await h.pass()
    // An old vector from epoch 1, past the 64 epochs a live cleanup looks back over.
    const old = Array.from({ length: h.deps.embedder.dimensions }, (_, i) => (i === 0 ? 1 : 0.5))
    await h.deps.vectors.upsert(h.organizationId, [
      {
        id: `${id}:1:99`,
        vector: old,
        attributes: { document_id: id, epoch: 1, chunk: 99, page: 1 },
      },
    ])
    for (let i = 0; i < 70; i++) {
      await Documents.remove(h.deps, h.context, id)
      await Documents.restore(h.deps, h.context, id)
    }
    await Documents.remove(h.deps, h.context, id)
    expect(await h.vectorIds(id)).toContain(`${id}:1:99`)

    await h.deps.time.advance(31 * DAY)
    await h.deps.workers.sweeps.run('purge')

    expect(h.document(id)).toBeUndefined()
    expect(await h.vectorIds(id)).toEqual([])
  })
})

describe('the sweeps run without the job loop (outside local, workers off)', () => {
  const API_ONLY = { ENVIRONMENT: 'dev', WORKERS_ENABLED: 'false' }

  test('a document deleted past retention is purged while a fresh upload stays uploaded', async () => {
    const h = createPipelineHarness({ env: API_ONLY })
    const old = await h.upload('old.txt', paragraphs(2, 'old'))
    await Documents.remove(h.deps, h.context, old)
    await h.deps.time.advance(31 * DAY)
    const fresh = await h.upload('fresh.txt', paragraphs(2, 'fresh'))

    h.deps.workers.start()
    await h.deps.time.advance(2 * h.deps.env.HOUSEKEEPING_INTERVAL_MS)
    await h.deps.workers.stop(1_000)

    expect(h.document(old)).toBeUndefined()
    expect(
      (await h.deps.objects.list(h.organizationId, { prefix: `documents/${old}/` })).items
    ).toEqual([])
    expect(h.document(fresh)?.state).toBe('uploaded')
    expect(h.deps.database.jobs(h.organizationId).map((j) => j.state)).toEqual(['queued'])
  })

  test('remove-all reaches 200 once the sweeps have purged what it erased', async () => {
    const h = createPipelineHarness({ env: API_ONLY })
    await h.upload('a.txt', paragraphs(2))
    const requestId = formatId('req', crypto.randomUUID())
    await expect(
      Documents.removeAll(h.deps, h.organizationId, requestId, 'bye')
    ).rejects.toMatchObject({ code: 'server.unavailable' })

    h.deps.workers.start()
    await h.deps.time.advance(2 * h.deps.env.SWEEP_INTERVAL_MS)
    await h.deps.workers.stop(1_000)

    await expect(
      Documents.removeAll(h.deps, h.organizationId, requestId, 'bye')
    ).resolves.toMatchObject({ status: 'removed' })
  })

  test('SWEEPS_ENABLED=false starts no sweep', async () => {
    const h = createPipelineHarness({ env: { ...API_ONLY, SWEEPS_ENABLED: 'false' } })
    const old = await h.upload('old.txt', paragraphs(2))
    await Documents.remove(h.deps, h.context, old)
    await h.deps.time.advance(31 * DAY)

    h.deps.workers.start()
    await h.deps.time.advance(2 * h.deps.env.HOUSEKEEPING_INTERVAL_MS)
    await h.deps.workers.stop(1_000)

    expect(h.document(old)?.state).toBe('deleted')
  })

  test('WORKERS_ENABLED=true in local still runs the job loop', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))

    h.deps.workers.start()
    await h.deps.time.advance(30_000)
    await h.deps.workers.stop(1_000)

    expect(h.document(id)?.state).toBe('ready')
  })
})
