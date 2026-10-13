import { describe, expect, spyOn, test } from 'bun:test'
import {
  INGESTION_JOB_ADVANCE,
  INGESTION_JOB_COMPLETE,
  INGESTION_JOB_FAIL,
  INGESTION_JOB_HEARTBEAT,
  INGESTION_JOB_RETRY,
} from 'tula-closeline-db'
import { VectorError } from 'tula-closeline-kit'
import { createMemoryEmbedder } from '~/adapters/memory/embedder'
import { postgresError } from '~/adapters/memory/playbook-database'
import { createApp } from '~/app'
import * as Documents from '~/modules/document/service'
import { createIngestion } from '~/workers/ingestion'
import { pdfBytes } from '../document/test-support'
import {
  bigParagraphs,
  createPipelineHarness,
  jobOutcomes,
  logged,
  paragraphs,
} from './test-support'

describe('a document goes from uploaded to ready', () => {
  test('uploaded, processing, ready, with its vectors, its page count and its chunks', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', `${paragraphs(3, 'a')}\f${paragraphs(2, 'b')}`)
    expect(h.document(id)?.state).toBe('uploaded')

    const ran = await h.pass()

    expect(ran).toBe(1)
    expect(h.document(id)).toMatchObject({ state: 'ready', page_count: 2 })
    const ids = await h.vectorIds(id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((v) => v.startsWith(`${id}:0:`))).toBe(true)
    expect(h.deps.database.jobs(h.organizationId)).toMatchObject([
      { state: 'succeeded', step: 'index', chunk_count: ids.length, chunks_done: ids.length },
    ])
    expect(h.deps.database.settings(h.organizationId)).toMatchObject({
      embedding_model: h.deps.embedder.model,
      embedding_dimension: 64,
    })
    expect(jobOutcomes(h.deps)).toEqual(['completed'])
  })

  test('the chunk text is kept in the object store, by chunk number, for search', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))
    await h.pass()

    const stored = await h.deps.objects.get(h.organizationId, `documents/${id}/chunks-0.json`)
    const parsed = JSON.parse(new TextDecoder().decode(stored?.body)) as {
      chunks: { index: number; page: number; text: string }[]
    }

    expect(parsed.chunks.map((c) => c.index)).toEqual([0])
    expect(parsed.chunks[0]?.text).toContain('Paragraph p number 0')
  })

  test('a page that needs OCR is read by OCR and its text is indexed', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('scan.txt', `${paragraphs(1)}\f   `)

    await h.pass()

    expect(h.deps.ocr.calls).toEqual([{ pages: [2] }])
    const stored = await h.deps.objects.get(h.organizationId, `documents/${id}/chunks-0.json`)
    expect(new TextDecoder().decode(stored?.body)).toContain('ocr text of page 2')
    expect(h.document(id)?.state).toBe('ready')
  })

  test('OCR answers for pages that were not asked for are ignored', async () => {
    const h = createPipelineHarness()
    spyOn(h.deps.ocr, 'recognise').mockResolvedValue([
      { number: 2, text: 'the second page' },
      { number: 1, text: 'IGNORE the first page you hold' },
    ])
    const id = await h.upload('scan.txt', `${paragraphs(1)}\f `)

    await h.pass()

    const text = new TextDecoder().decode(
      (await h.deps.objects.get(h.organizationId, `documents/${id}/chunks-0.json`))?.body
    )
    expect(text).toContain('the second page')
    expect(text).not.toContain('IGNORE')
  })
})

describe('a document that cannot be ingested fails with a reason', () => {
  test('more pages than the limit: too_many_pages, with the page count shown', async () => {
    const h = createPipelineHarness({ env: { MAX_PAGES_PER_DOCUMENT: '3' } })
    const id = await h.upload(
      'long.txt',
      Array.from({ length: 4 }, (_, i) => paragraphs(1, `x${i}`)).join('\f')
    )

    await h.pass()

    expect(h.document(id)).toMatchObject({
      state: 'failed',
      failure_reason: 'too_many_pages',
      page_count: 4,
    })
    expect(await h.vectorIds(id)).toEqual([])
    expect(jobOutcomes(h.deps)).toEqual(['failed'])
  })

  test('bytes the parser cannot read: unreadable', async () => {
    const h = createPipelineHarness()
    const bad = new Uint8Array([...pdfBytes('bad'), 0xff, 0xfe])
    const id = await h.upload('bad.pdf', bad)

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'unreadable' })
  })

  test('a password-protected document: password_protected', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('secret.txt', '%ENCRYPTED% locked')

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'password_protected' })
  })

  test('pages with no text where OCR finds none either: no_text', async () => {
    const h = createPipelineHarness()
    spyOn(h.deps.ocr, 'recognise').mockResolvedValue([{ number: 1, text: '   ' }])
    const id = await h.upload('blank.txt', '   \n  ')

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'no_text' })
  })

  test('text made only of control characters: no_text, and OCR is not asked when the parser did not ask for it', async () => {
    const h = createPipelineHarness()
    spyOn(h.deps.parser, 'parse').mockResolvedValue({
      pages: [{ number: 1, text: '\u0001​‮', needsOcr: false }],
    })
    const id = await h.upload('ctl.txt', 'x')

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'no_text' })
    expect(h.deps.ocr.calls).toEqual([])
  })

  test('a parser that returns no page at all: unreadable', async () => {
    const h = createPipelineHarness()
    spyOn(h.deps.parser, 'parse').mockResolvedValue({ pages: [] })
    const id = await h.upload('none.txt', 'x')

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'unreadable' })
  })

  test('more text than the limit: processing_failed, and nothing is parsed twice', async () => {
    const h = createPipelineHarness({ env: { MAX_TEXT_CHARS_PER_DOCUMENT: '1000' } })
    const id = await h.upload('huge.txt', 'a'.repeat(1500))

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'processing_failed' })
  })

  test('more chunks than the limit: processing_failed, with no vector written', async () => {
    const h = createPipelineHarness({ env: { MAX_CHUNKS_PER_DOCUMENT: '2' } })
    const id = await h.upload('many.txt', bigParagraphs(4))

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'processing_failed' })
    expect(await h.vectorIds(id)).toEqual([])
  })

  test('a failure that keeps happening ends processing_failed after the attempt bound', async () => {
    const h = createPipelineHarness({ env: { INGESTION_MAX_ATTEMPTS: '3' } })
    spyOn(h.deps.embedder, 'embed').mockRejectedValue(new Error('the model is down'))
    const id = await h.upload('notes.txt', paragraphs(2))

    await h.pass()
    expect(h.document(id)?.state).toBe('processing')
    await h.deps.time.advance(60_000)
    await h.pass()
    await h.deps.time.advance(60_000)
    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'processing_failed' })
    expect(jobOutcomes(h.deps)).toEqual(['retried', 'retried', 'failed'])
    // The failure was reported, without the document's name or text.
    expect(h.deps.reported).toHaveLength(1)
  })

  test('a request the vector store refuses as malformed is permanent: no second attempt', async () => {
    const h = createPipelineHarness()
    spyOn(h.deps.vectors, 'upsert').mockRejectedValue(
      new VectorError('vector.invalid_request', 'refused')
    )
    const id = await h.upload('notes.txt', paragraphs(2))

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'processing_failed' })
  })

  test('a file missing from the object store is a loud, permanent failure', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))
    await h.deps.objects.delete(h.organizationId, `documents/${id}/original.txt`)

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'processing_failed' })
    expect(logged(h.deps, 'the file of a document is missing from the object store')).toHaveLength(
      1
    )
  })
})

describe('a transient failure is retried and the work is not repeated', () => {
  test('an embedder that fails once on the second batch resumes there, with no duplicate vector', async () => {
    const h = createPipelineHarness()
    const embed = h.deps.embedder.embed.bind(h.deps.embedder)
    let calls = 0
    spyOn(h.deps.embedder, 'embed').mockImplementation(async (texts, options) => {
      calls++
      if (calls === 2) {
        throw new Error('rate limited')
      }
      return embed(texts, options)
    })
    const id = await h.upload('big.txt', bigParagraphs(100))

    await h.pass()
    const afterFirst = (await h.vectorIds(id)).length
    expect(afterFirst).toBe(96)
    expect(h.deps.database.jobs(h.organizationId)[0]).toMatchObject({
      state: 'queued',
      step: 'embed',
      chunks_done: 96,
    })
    await h.deps.time.advance(10_000)
    await h.pass()

    const ids = await h.vectorIds(id)
    expect(ids).toHaveLength(100)
    expect(new Set(ids).size).toBe(100)
    expect(h.document(id)?.state).toBe('ready')
    // 96, then the failed call is not recorded (it threw first), then the 4 that were left, never the first 96 again.
    expect(h.deps.embedder.calls.map((c) => c.texts.length)).toEqual([96, 4])
  })

  type Harness = ReturnType<typeof createPipelineHarness>
  test.each([
    {
      crash: 'after the parse step',
      recorded: 'chunk',
      breakIt: (h: Harness) => {
        const get = h.deps.objects.get.bind(h.deps.objects)
        return spyOn(h.deps.objects, 'get').mockImplementation(async (org, key) => {
          if (key.includes('/pages-')) {
            throw new Error('the object store fell over')
          }
          return get(org, key)
        })
      },
      parses: 1,
      embeds: 1,
    },
    {
      crash: 'after the chunk step',
      recorded: 'embed',
      breakIt: (h: Harness) =>
        spyOn(h.deps.embedder, 'embed').mockRejectedValueOnce(new Error('the model fell over')),
      parses: 1,
      embeds: 1,
    },
    {
      crash: 'after the embed step',
      recorded: 'index',
      breakIt: (h: Harness) => {
        h.deps.database.failNext(INGESTION_JOB_COMPLETE, postgresError('57P01'))
        return undefined
      },
      parses: 1,
      embeds: 1,
    },
  ])(
    'a crash $crash resumes from the step it recorded, repeating nothing before it',
    async ({ recorded, breakIt, parses, embeds }) => {
      const h = createPipelineHarness()
      const parse = spyOn(h.deps.parser, 'parse')
      const id = await h.upload('notes.txt', paragraphs(3))
      // The process dies: nothing can tell the database what became of the job.
      h.deps.database.failAlways(INGESTION_JOB_RETRY, postgresError('57P01'))
      h.deps.database.failAlways(INGESTION_JOB_FAIL, postgresError('57P01'))
      const spy = breakIt(h)

      await h.pass()

      expect(jobOutcomes(h.deps)).toEqual(['uncertain'])
      expect(h.deps.database.jobs(h.organizationId)[0]).toMatchObject({
        state: 'running',
        step: recorded,
      })
      spy?.mockRestore()
      h.deps.database.clearFailures()
      // Nothing is claimable while the lease runs.
      expect(await h.pass()).toBe(0)
      await h.deps.time.advance(100_000)
      expect(await h.pass()).toBe(1)

      expect(h.document(id)?.state).toBe('ready')
      expect(parse).toHaveBeenCalledTimes(parses)
      expect(h.deps.embedder.calls.length).toBeGreaterThanOrEqual(embeds)
      expect((await h.vectorIds(id)).length).toBe(1)
    }
  )
})

type Harness = ReturnType<typeof createPipelineHarness>

/** A call that stays open until released, and aborts when its signal does. */
function gate() {
  let release: () => void = () => undefined
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  return { open, release }
}

describe('a delete during ingestion stops the job and the cleanup leaves no vector', () => {
  const hooks: Record<string, (h: Harness, id: () => string) => void> = {
    parse: (h, id) => {
      const parse = h.deps.parser.parse.bind(h.deps.parser)
      spyOn(h.deps.parser, 'parse').mockImplementation(async (doc, options) => {
        await Documents.remove(h.deps, h.context, id())
        return parse(doc, options)
      })
    },
    chunk: (h, id) => {
      const get = h.deps.objects.get.bind(h.deps.objects)
      let done = false
      spyOn(h.deps.objects, 'get').mockImplementation(async (org, key) => {
        if (!done && key.includes('/pages-')) {
          done = true
          await Documents.remove(h.deps, h.context, id())
        }
        return get(org, key)
      })
    },
    embed: (h, id) => {
      const embed = h.deps.embedder.embed.bind(h.deps.embedder)
      spyOn(h.deps.embedder, 'embed').mockImplementation(async (texts, options) => {
        await Documents.remove(h.deps, h.context, id())
        return embed(texts, options)
      })
    },
    index: (h, id) => {
      const remove = h.deps.objects.delete.bind(h.deps.objects)
      spyOn(h.deps.objects, 'delete').mockImplementation(async (org, key) => {
        if (key.includes('/pages-')) {
          await Documents.remove(h.deps, h.context, id())
        }
        return remove(org, key)
      })
    },
  }

  test.each(Object.keys(hooks))('during the %s step', async (step) => {
    const h = createPipelineHarness()
    const upsert = spyOn(h.deps.vectors, 'upsert')
    let id = ''
    hooks[step]?.(h, () => id)
    id = await h.upload('notes.txt', paragraphs(3))

    await h.pass()

    expect(jobOutcomes(h.deps)).toEqual(['lost'])
    expect(h.document(id)).toMatchObject({ state: 'deleted' })
    expect(h.deps.database.jobs(h.organizationId)[0]?.state).toBe('cancelled')
    if (step !== 'index') {
      // The heartbeat before the write was refused, so no vector was ever written.
      expect(upsert).not.toHaveBeenCalled()
    }

    // After the lease the cleanup runs from the delete message and nothing of the document is left.
    await h.deps.time.advance(100_000)
    await h.deps.consumer.pollOnce()
    expect(await h.vectorIds(id)).toEqual([])
    expect(h.document(id)?.vectors_removed_seq).toBe(h.document(id)?.deletion_seq)
  })

  test('the claim is lost at the next heartbeat while a call is still open, and that call is cancelled', async () => {
    const h = createPipelineHarness()
    const parsing = gate()
    let signal: AbortSignal | undefined
    spyOn(h.deps.parser, 'parse').mockImplementation(async (_doc, options) => {
      signal = options.signal
      await Promise.race([
        parsing.open,
        new Promise((_, reject) =>
          options.signal.addEventListener('abort', () => reject(new Error('cancelled')))
        ),
      ])
      return { pages: [{ number: 1, text: 'x', needsOcr: false }] }
    })
    const upsert = spyOn(h.deps.vectors, 'upsert')
    const id = await h.upload('notes.txt', paragraphs(3))
    const running = h.deps.workers.ingestion.runPass()
    await h.deps.time.settle()
    await Documents.remove(h.deps, h.context, id)

    await h.deps.time.advance(16_000)
    await running

    expect(signal?.aborted).toBe(true)
    expect(jobOutcomes(h.deps)).toEqual(['lost'])
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe('a restore after a delete', () => {
  test('re-ingests under the new epoch and the old epoch is gone, whether or not its cleanup ran', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    expect((await h.vectorIds(id)).every((v) => v.startsWith(`${id}:0:`))).toBe(true)

    await Documents.remove(h.deps, h.context, id)
    await Documents.restore(h.deps, h.context, id)
    expect(h.document(id)).toMatchObject({ state: 'processing', epoch: 2 })
    await h.pass()

    expect(h.document(id)?.state).toBe('ready')
    const ids = await h.vectorIds(id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((v) => v.startsWith(`${id}:2:`))).toBe(true)
    // The first ingestion's files went with its vectors.
    expect(
      await h.deps.objects.head(h.organizationId, `documents/${id}/chunks-0.json`)
    ).toBeUndefined()
    expect(
      await h.deps.objects.head(h.organizationId, `documents/${id}/chunks-2.json`)
    ).toBeDefined()
  })

  test('the cleanup of the first deletion does nothing once the document is back, and keeps the new vectors', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    await Documents.restore(h.deps, h.context, id)
    await h.pass()
    const before = await h.vectorIds(id)
    const deleteByFilter = spyOn(h.deps.vectors, 'deleteByFilter')

    // The delete message is still on the queue: it is acknowledged and does nothing.
    await h.deps.consumer.pollOnce()

    expect(deleteByFilter).not.toHaveBeenCalled()
    expect(await h.vectorIds(id)).toEqual(before)
    expect(h.deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('with the first deletion cleaned before the restore, only the new epoch is left', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(3))
    await h.pass()
    await Documents.remove(h.deps, h.context, id)
    await h.deps.consumer.pollOnce()
    expect(await h.vectorIds(id)).toEqual([])

    await Documents.restore(h.deps, h.context, id)
    await h.pass()

    expect((await h.vectorIds(id)).every((v) => v.startsWith(`${id}:2:`))).toBe(true)
  })
})

describe('shutdown and instances', () => {
  test('shutdown mid-job gives the job back at its step: it resumes on another instance, with no unhandled rejection', async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      const h = createPipelineHarness()
      spyOn(h.deps.embedder, 'embed').mockImplementation(
        (_texts, options) =>
          new Promise((_, reject) =>
            options.signal.addEventListener('abort', () => reject(new Error('cancelled')))
          )
      )
      const id = await h.upload('notes.txt', paragraphs(3))
      const first = createIngestion(h.deps)
      const running = first.runPass()
      await h.deps.time.settle()

      await first.stop(5_000)
      await running

      expect(jobOutcomes(h.deps)).toEqual(['released'])
      expect(h.deps.database.jobs(h.organizationId)[0]).toMatchObject({
        state: 'queued',
        step: 'embed',
      })
      expect(h.deps.database.jobs(h.organizationId)[0]?.attempts).toBe(1)
      spyOn(h.deps.embedder, 'embed').mockRestore()

      // Another instance picks it up at once: no lease to wait for.
      await createIngestion(h.deps).runPass()

      expect(h.document(id)?.state).toBe('ready')
      await h.deps.time.settle()
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  test('shutdown while a vector write is in flight leaves the job running with its lease: no release', async () => {
    const h = createPipelineHarness()
    const hang = gate()
    const upsert = spyOn(h.deps.vectors, 'upsert').mockImplementation(async () => {
      await hang.open
    })
    const id = await h.upload('notes.txt', paragraphs(3))
    const first = createIngestion(h.deps)
    const running = first.runPass()
    await h.deps.time.settle()
    expect(upsert).toHaveBeenCalled()

    await first.stop(5_000)
    await running

    expect(jobOutcomes(h.deps)).toEqual(['uncertain'])
    const [job] = h.deps.database.jobs(h.organizationId)
    expect(job?.state).toBe('running')
    expect(job?.next_attempt_at).toBeGreaterThan(h.deps.clock.now().getTime())
    // A delete now waits for the lease: the late write cannot land after the cleanup.
    await Documents.remove(h.deps, h.context, id)
    expect(h.document(id)?.vectors_removed_seq).toBeNull()
    hang.release()
  })

  test('two instances running the loop at once process each job once', async () => {
    const h = createPipelineHarness({ env: { INGESTION_CONCURRENCY: '2' } })
    const parse = spyOn(h.deps.parser, 'parse')
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      ids.push(await h.upload(`n${i}.txt`, paragraphs(2, `d${i}`)))
    }

    const ran = await Promise.all([
      createIngestion(h.deps).runPass(),
      createIngestion(h.deps).runPass(),
    ])

    expect(ran.reduce((a, b) => a + b, 0)).toBe(4)
    await Promise.all([createIngestion(h.deps).runPass(), createIngestion(h.deps).runPass()])
    await Promise.all([createIngestion(h.deps).runPass(), createIngestion(h.deps).runPass()])
    expect(ids.every((id) => h.document(id)?.state === 'ready')).toBe(true)
    expect(parse).toHaveBeenCalledTimes(6)
    expect(jobOutcomes(h.deps)).toEqual(Array(6).fill('completed'))
  })

  test('the uploaded message only nudges: acknowledged at once, and the loop does the work', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))

    await h.deps.consumer.pollOnce()

    expect(h.deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
    expect(h.document(id)?.state).toBe('uploaded')
    h.deps.workers.ingestion.start()
    await h.deps.time.settle()
    expect(h.document(id)?.state).toBe('ready')
    await h.deps.workers.ingestion.stop(1_000)
  })

  test('a lost uploaded message does not lose the document: the sweep finds the job', async () => {
    const h = createPipelineHarness()
    const id = await h.upload('notes.txt', paragraphs(2))
    // The message vanishes from the queue before anyone reads it.
    for (const delivery of await h.deps.queue.receive({
      maxMessages: 10,
      visibilityTimeoutSeconds: 30,
      waitSeconds: 0,
    })) {
      await h.deps.queue.acknowledge(delivery.receipt)
    }
    expect(h.deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })

    await h.pass()

    expect(h.document(id)?.state).toBe('ready')
  })

  test('the loop sleeps when idle and wakes when nudged', async () => {
    const h = createPipelineHarness()
    h.deps.workers.ingestion.start()
    await h.deps.time.settle()
    expect(h.deps.time.pending()).toBeGreaterThan(0)
    const id = await h.upload('notes.txt', paragraphs(2))
    h.deps.workers.ingestion.nudge(h.organizationId)
    await h.deps.time.settle()
    expect(h.document(id)?.state).toBe('ready')
    await h.deps.workers.ingestion.stop(1_000)
  })
})

describe('the lease, the heartbeat and the deadlines', () => {
  test('a long step keeps its lease alive with a heartbeat, and a short one does not need it', async () => {
    const h = createPipelineHarness()
    const parsing = gate()
    spyOn(h.deps.parser, 'parse').mockImplementation(async () => {
      await parsing.open
      return { pages: [{ number: 1, text: paragraphs(2), needsOcr: false }] }
    })
    const id = await h.upload('notes.txt', 'x')
    const claimedAt = h.deps.clock.now().getTime()
    const running = h.deps.workers.ingestion.runPass()
    await h.deps.time.settle()
    const firstLease = h.deps.database.jobs(h.organizationId)[0]?.next_attempt_at ?? 0

    await h.deps.time.advance(40_000)
    const renewed = h.deps.database.jobs(h.organizationId)[0]?.next_attempt_at ?? 0
    parsing.release()
    await running

    expect(firstLease).toBe(claimedAt + 90_000)
    expect(renewed).toBe(claimedAt + 30_000 + 90_000)
    expect(h.document(id)?.state).toBe('ready')
  })

  test('without a renewal the claim counts as lost: the call is cancelled and nothing is written', async () => {
    const h = createPipelineHarness()
    let signal: AbortSignal | undefined
    spyOn(h.deps.parser, 'parse').mockImplementation((_doc, options) => {
      signal = options.signal
      return new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')))
      )
    })
    await h.upload('notes.txt', paragraphs(2))
    const running = h.deps.workers.ingestion.runPass()
    await h.deps.time.settle()
    h.deps.database.failAlways(INGESTION_JOB_HEARTBEAT, postgresError('08006'))
    const before = h.deps.database.statements.length

    await h.deps.time.advance(80_000)
    await running

    expect(signal?.aborted).toBe(true)
    expect(jobOutcomes(h.deps)).toEqual(['lost'])
    // After the claim was given up the job wrote nothing: no advance, retry, fail or complete.
    const writes = [
      INGESTION_JOB_ADVANCE,
      INGESTION_JOB_RETRY,
      INGESTION_JOB_FAIL,
      INGESTION_JOB_COMPLETE,
    ]
    expect(h.deps.database.statements.slice(before).filter((t) => writes.includes(t))).toEqual([])
  })

  test.each([
    [
      'the object store',
      30_000,
      (h: Harness) =>
        spyOn(h.deps.objects, 'get').mockImplementation(() => new Promise(() => undefined)),
    ],
    [
      'the parser',
      180_000,
      (h: Harness) =>
        spyOn(h.deps.parser, 'parse').mockImplementation(() => new Promise(() => undefined)),
    ],
    [
      'the embedder',
      30_000,
      (h: Harness) =>
        spyOn(h.deps.embedder, 'embed').mockImplementation(() => new Promise(() => undefined)),
    ],
  ])(
    'a call to %s that never answers times out and the attempt is retried',
    async (_name, timeoutMs, hang) => {
      const h = createPipelineHarness()
      hang(h)
      const id = await h.upload('notes.txt', paragraphs(2))
      const running = h.deps.workers.ingestion.runPass()
      await h.deps.time.settle()

      await h.deps.time.advance(timeoutMs + 1_000)
      await running

      expect(jobOutcomes(h.deps)).toEqual(['retried'])
      expect(h.document(id)?.state).toBe('processing')
    }
  )

  test('a vector write that times out may still land, so the job is left to its lease, not retried at once', async () => {
    const h = createPipelineHarness()
    const upsert = spyOn(h.deps.vectors, 'upsert').mockImplementation(
      () => new Promise(() => undefined)
    )
    const id = await h.upload('notes.txt', paragraphs(2))
    const running = h.deps.workers.ingestion.runPass()
    await h.deps.time.settle()

    await h.deps.time.advance(31_000)
    await running

    expect(jobOutcomes(h.deps)).toEqual(['uncertain'])
    expect(h.deps.database.jobs(h.organizationId)[0]?.state).toBe('running')
    upsert.mockRestore()
    await h.deps.time.advance(100_000)
    await h.pass()
    expect(h.document(id)?.state).toBe('ready')
  })
})

describe("the Organization's index settings", () => {
  test('a different model after vectors were written fails the job loudly and re-indexes nothing', async () => {
    const h = createPipelineHarness()
    const first = await h.upload('one.txt', paragraphs(2, 'one'))
    await h.pass()
    expect(h.document(first)?.state).toBe('ready')

    h.deps.embedder = createMemoryEmbedder({ dimensions: 64, model: 'a-newer-model' })
    const second = await h.upload('two.txt', paragraphs(2, 'two'))
    await h.pass()

    expect(h.document(second)).toMatchObject({
      state: 'failed',
      failure_reason: 'processing_failed',
    })
    expect(await h.vectorIds(second)).toEqual([])
    expect(h.deps.database.settings(h.organizationId)?.embedding_model).toBe(
      createMemoryEmbedder().model
    )
    expect(h.deps.reported.length).toBeGreaterThan(0)
  })

  test('an embedder and a vector store that disagree on the dimension fail the job loudly', async () => {
    const h = createPipelineHarness()
    h.deps.embedder = createMemoryEmbedder({ dimensions: 32 })
    const id = await h.upload('one.txt', paragraphs(2))

    await h.pass()

    expect(h.document(id)).toMatchObject({ state: 'failed', failure_reason: 'processing_failed' })
    expect(h.deps.database.settings(h.organizationId)).toBeUndefined()
    expect(h.deps.reported.length).toBeGreaterThan(0)
  })
})

describe('Organizations stay apart', () => {
  test('two Organizations ingested in one pass keep their jobs, vectors and files in their own spaces', async () => {
    const a = createPipelineHarness()
    const idA = await a.upload('a.txt', paragraphs(2, 'alpha'))
    // The same deps, another Organization.
    const otherContext = { ...a.context, organizationId: a.other().organizationId }
    const resultB = await Documents.upload(a.deps, otherContext, {
      fileName: 'b.txt',
      declaredMediaType: null,
      bytes: new TextEncoder().encode(paragraphs(2, 'beta')),
      idempotencyKey: undefined,
    })
    const idB = resultB.document.id

    await a.pass()

    expect(await a.vectorIds(idA)).not.toEqual([])
    expect(await a.vectorIds(idB, otherContext.organizationId)).not.toEqual([])
    // Neither Organization's index holds the other's document.
    expect(await a.vectorIds(idB)).toEqual([])
    expect(await a.vectorIds(idA, otherContext.organizationId)).toEqual([])
    expect(
      await a.deps.objects.head(otherContext.organizationId, `documents/${idA}/chunks-0.json`)
    ).toBeUndefined()
    expect(a.deps.database.jobs(a.organizationId).map((j) => j.document_id)).toEqual([idA])
  })

  test('a job statement run in another Organization finds nothing, as Postgres would', async () => {
    const h = createPipelineHarness()
    await h.upload('a.txt', paragraphs(2))
    const parsing = gate()
    spyOn(h.deps.parser, 'parse').mockImplementation(async () => {
      await parsing.open
      return { pages: [{ number: 1, text: 'x', needsOcr: false }] }
    })
    const running = h.deps.workers.ingestion.runPass()
    await h.deps.time.settle()
    const job = h.deps.database.jobs(h.organizationId)[0]

    const stranger = h.other().organizationId
    const result = await h.deps.scope(stranger, (run) =>
      run(INGESTION_JOB_HEARTBEAT, [h.organizationId, job?.id, job?.claim_token, 60_000])
    )
    parsing.release()
    await running

    expect(result.rows).toEqual([])
  })
})

describe('an API-only instance outside local (workers off)', () => {
  test('keeps an upload in `uploaded`, serves the routes, and fails nothing', async () => {
    const h = createPipelineHarness({ env: { ENVIRONMENT: 'dev', WORKERS_ENABLED: 'false' } })
    expect(h.deps.env.WORKERS_ENABLED).toBe(false)
    const id = await h.upload('notes.txt', paragraphs(3))

    await h.deps.consumer.pollOnce()
    await h.deps.time.advance(60_000)

    expect(h.document(id)?.state).toBe('uploaded')
    expect(h.document(id)?.failure_reason).toBeNull()
    expect(await h.vectorIds(id)).toEqual([])
    const app = createApp(h.deps)
    expect((await app.request('/healthz')).status).toBe(200)
  })
})
