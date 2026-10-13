import {
  type DocumentFailureReason,
  type DocumentMediaType,
  MEDIA_TYPE_BY_EXTENSION,
} from 'tula-closeline-contract'
import {
  type ClaimedIngestionJob,
  DOCUMENT_GET,
  INDEX_SETTINGS_UPSERT,
  INDEX_VECTORS_MARK,
  INGESTION_JOB_ADVANCE,
  INGESTION_JOB_COMPLETE,
  INGESTION_JOB_FAIL,
  INGESTION_JOB_HEARTBEAT,
  INGESTION_JOB_RETRY,
} from 'tula-closeline-db'
import { DOCUMENT_MAX_PAGE_COUNT } from 'tula-closeline-db/schema'
import { MAX_EMBED_TEXTS } from '~/ports/embedder'
import { ParseError } from '~/ports/parser'
import { type Chunk, ChunkLimitError, chunkPages, cleanText } from './chunker'
import {
  CallTimeout,
  ClaimLost,
  chunksKey,
  inTransaction,
  isCancellation,
  isPermanent,
  originalKey,
  PermanentFailure,
  type PipelineDeps,
  pagesKey,
  reportWorkerError,
  retryDelayMs,
  ShuttingDown,
  vectorId,
  within,
} from './runtime'
import {
  chunksArtifactSchema,
  deleteArtifactsUpTo,
  deleteVectorsUpTo,
  pagesArtifactSchema,
} from './vectors'

/** How a run of a job ended; the loop counts them and the tests read them. */
export type JobOutcome =
  /** The document is `ready`. */
  | 'completed'
  /** The job ended `failed` with a reason. */
  | 'failed'
  /** A transient failure; the job is queued again with a delay. */
  | 'retried'
  /** The claim was lost (the document was deleted or the lease lapsed); nothing more was written. */
  | 'lost'
  /** Shutdown: the job was given back at a step boundary and is due at once. */
  | 'released'
  /** A write may or may not have landed, or the database could not be told; the lease is left to lapse. */
  | 'uncertain'

/** A vector write that timed out: it may still land, so the claim is left to lapse rather than renewed. */
class UncertainWrite extends Error {
  /** Creates the signal. */
  constructor() {
    super('a vector write ran out of time and may still land')
    this.name = 'UncertainWrite'
  }
}

/** The pages OCR is asked for in one call. */
const OCR_PAGES_PER_CALL = 50

/** The most times the index settings are read again after losing a race with another mark. */
const SETTINGS_ATTEMPTS = 3

type Step = 'parse' | 'chunk' | 'embed' | 'index'

type Progress = { chunkCount: number | null; chunksDone: number }

/** What every step of one run needs. */
type JobContext = {
  deps: PipelineDeps
  organizationId: string
  jobId: string
  documentId: string
  epoch: number
  token: string
  /** Aborts on shutdown or on a lost claim: pass it to every call. */
  signal: AbortSignal
  lost: AbortController
  progress: Progress
}

/** Renews the lease once; false means the claim is gone. */
async function heartbeatOnce(c: JobContext): Promise<boolean> {
  const { deps } = c
  const result = await inTransaction(deps, c.organizationId, (run) =>
    run(INGESTION_JOB_HEARTBEAT, [c.organizationId, c.jobId, c.token, deps.env.INGESTION_LEASE_MS])
  )
  return result.rows.length > 0
}

/** Confirms the claim is alive right now; throws {@link ClaimLost} (and stops every call) when it is not. */
async function beat(c: JobContext): Promise<void> {
  c.signal.throwIfAborted()
  if (!(await heartbeatOnce(c))) {
    c.lost.abort(new ClaimLost())
    throw new ClaimLost()
  }
}

/** Records the step and counts and renews the lease; no row means the claim is gone. */
async function advance(
  c: JobContext,
  step: Step,
  fields: { artifact?: string; pages?: number; chunks?: number; done?: number } = {}
): Promise<void> {
  c.signal.throwIfAborted()
  const { deps } = c
  const result = await inTransaction(deps, c.organizationId, (run) =>
    run(INGESTION_JOB_ADVANCE, [
      c.organizationId,
      c.jobId,
      c.token,
      step,
      fields.artifact ?? null,
      fields.pages ?? null,
      fields.chunks ?? null,
      fields.done ?? null,
      deps.env.INGESTION_LEASE_MS,
    ])
  )
  if (result.rows.length === 0) {
    c.lost.abort(new ClaimLost())
    throw new ClaimLost()
  }
}

/** Starts the lease timer; `stop` ends it. Too long without a successful renewal counts as a lost claim. */
function startHeartbeat(c: JobContext): { stop: () => Promise<void> } {
  const { deps } = c
  const control = new AbortController()
  let lastOk = deps.clock.now().getTime()
  const loop = (async () => {
    while (!control.signal.aborted) {
      await deps.sleep(deps.env.INGESTION_HEARTBEAT_MS, control.signal)
      if (control.signal.aborted) {
        return
      }
      try {
        if (await heartbeatOnce(c)) {
          lastOk = deps.clock.now().getTime()
        } else {
          c.lost.abort(new ClaimLost())
          return
        }
      } catch (error) {
        deps.logger.warn('a job heartbeat failed', {
          organizationId: c.organizationId,
          jobId: c.jobId,
          error: error instanceof Error ? error.name : 'unknown',
        })
        // Without a renewal for this long the lease may have lapsed: stop writing.
        const quiet = deps.clock.now().getTime() - lastOk
        if (quiet >= deps.env.INGESTION_LEASE_MS - deps.env.INGESTION_HEARTBEAT_MS) {
          c.lost.abort(new ClaimLost())
          return
        }
      }
    }
  })()
  return {
    stop: async () => {
      control.abort()
      await loop
    },
  }
}

/** The document the job works on, read once at the start; the claim already checked it is live at the job's epoch. */
async function readDocument(
  c: JobContext
): Promise<{ detectedType: string; epoch: number; state: string } | undefined> {
  const result = await inTransaction(c.deps, c.organizationId, (run) =>
    run(DOCUMENT_GET, [c.organizationId, c.documentId])
  )
  const row = result.rows[0]
  if (row === undefined) {
    return undefined
  }
  return {
    detectedType: String(row.detected_type),
    epoch: Number(row.epoch),
    state: String(row.state),
  }
}

/** Reads one of the pipeline's own objects and checks its shape; a missing or malformed one is a permanent failure. */
async function readArtifact<T>(
  c: JobContext,
  key: string,
  parse: (value: unknown) => T | undefined
): Promise<T> {
  const { deps } = c
  const stored = await within(
    deps,
    'object store',
    deps.env.INGESTION_IO_TIMEOUT_MS,
    c.signal,
    () => deps.objects.get(c.organizationId, key)
  )
  if (stored === undefined) {
    deps.logger.error('a resume point of an ingestion job is missing', {
      organizationId: c.organizationId,
      documentId: c.documentId,
      jobId: c.jobId,
    })
    throw new PermanentFailure('processing_failed')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(stored.body))
  } catch {
    throw new PermanentFailure('processing_failed')
  }
  const parsed = parse(value)
  if (parsed === undefined) {
    throw new PermanentFailure('processing_failed')
  }
  return parsed
}

/** Writes one of the pipeline's own objects as JSON. */
async function writeArtifact(c: JobContext, key: string, value: unknown): Promise<void> {
  const { deps } = c
  const body = new TextEncoder().encode(JSON.stringify(value))
  await within(deps, 'object store', deps.env.INGESTION_IO_TIMEOUT_MS, c.signal, () =>
    deps.objects.put(c.organizationId, key, body, { contentType: 'application/json' })
  )
}

/** Parse step: read the file, parse it, OCR the pages that need it, keep the pages, record the page count. */
async function parseStep(c: JobContext, detectedType: string): Promise<void> {
  const { deps } = c
  const { env } = deps
  const mediaType = (MEDIA_TYPE_BY_EXTENSION as Record<string, DocumentMediaType | undefined>)[
    `.${detectedType}`
  ]
  if (mediaType === undefined) {
    throw new PermanentFailure('unreadable')
  }
  const file = await within(deps, 'object store', env.INGESTION_IO_TIMEOUT_MS, c.signal, () =>
    deps.objects.get(c.organizationId, originalKey(c.documentId, detectedType))
  )
  if (file === undefined) {
    deps.logger.error('the file of a document is missing from the object store', {
      organizationId: c.organizationId,
      documentId: c.documentId,
    })
    throw new PermanentFailure('processing_failed')
  }
  const document = { bytes: file.body, mediaType }
  const parsed = await within(deps, 'parser', env.INGESTION_PARSE_TIMEOUT_MS, c.signal, (signal) =>
    deps.parser.parse(document, { signal })
  )
  const count = parsed.pages.length
  if (count === 0) {
    throw new PermanentFailure('unreadable')
  }
  if (count > env.MAX_PAGES_PER_DOCUMENT) {
    await advance(c, 'parse', { pages: Math.min(count, DOCUMENT_MAX_PAGE_COUNT) })
    throw new PermanentFailure('too_many_pages')
  }

  const texts = new Map<number, string>()
  const needOcr: number[] = []
  for (const page of parsed.pages) {
    texts.set(page.number, page.text)
    if (page.needsOcr) {
      needOcr.push(page.number)
    }
  }
  for (let from = 0; from < needOcr.length; from += OCR_PAGES_PER_CALL) {
    const wanted = needOcr.slice(from, from + OCR_PAGES_PER_CALL)
    const read = await within(deps, 'ocr', env.INGESTION_PARSE_TIMEOUT_MS, c.signal, (signal) =>
      deps.ocr.recognise({ ...document, pages: wanted }, { signal })
    )
    for (const page of read) {
      // Only pages that were asked for: the answer is untrusted.
      if (wanted.includes(page.number)) {
        texts.set(page.number, page.text)
      }
    }
  }

  let total = 0
  let anyText = false
  for (const text of texts.values()) {
    total += text.length
    if (total > env.MAX_TEXT_CHARS_PER_DOCUMENT) {
      throw new PermanentFailure('processing_failed')
    }
    if (!anyText && cleanText(text).trim() !== '') {
      anyText = true
    }
  }
  if (!anyText) {
    throw new PermanentFailure('no_text')
  }

  const pages = [...texts].map(([number, text]) => ({ number, text }))
  const key = pagesKey(c.documentId, c.epoch)
  await writeArtifact(c, key, { pages })
  await advance(c, 'chunk', { artifact: key, pages: Math.min(count, DOCUMENT_MAX_PAGE_COUNT) })
}

/** Chunk step: cut the kept pages into chunks, keep them, record how many there are. */
async function chunkStep(c: JobContext): Promise<void> {
  const { env } = c.deps
  const { pages } = await readArtifact(c, pagesKey(c.documentId, c.epoch), (value) => {
    const result = pagesArtifactSchema.safeParse(value)
    return result.success ? result.data : undefined
  })
  let chunks: Chunk[]
  try {
    chunks = chunkPages(pages, {
      targetChars: env.CHUNK_TARGET_CHARS,
      maxChars: env.CHUNK_MAX_CHARS,
      overlapChars: env.CHUNK_OVERLAP_CHARS,
      maxChunks: env.MAX_CHUNKS_PER_DOCUMENT,
    })
  } catch (error) {
    if (error instanceof ChunkLimitError) {
      throw new PermanentFailure('processing_failed')
    }
    throw error
  }
  if (chunks.length === 0) {
    throw new PermanentFailure('no_text')
  }
  const key = chunksKey(c.documentId, c.epoch)
  await writeArtifact(c, key, { chunks })
  c.progress.chunkCount = chunks.length
  c.progress.chunksDone = 0
  await advance(c, 'embed', { artifact: key, chunks: chunks.length, done: 0 })
}

/**
 * Fixes the Organization's embedding model and dimension before its first vector (ADR 0010). A
 * model or dimension that differs from the recorded one is refused by the database; the job then
 * fails, loudly, and nothing is re-indexed.
 */
async function ensureIndexSettings(c: JobContext): Promise<void> {
  const { deps } = c
  const { embedder } = deps
  if (deps.vectors.dimensions !== embedder.dimensions) {
    reportWorkerError(
      deps,
      new Error('the embedder and the vector store disagree on the dimension count'),
      { worker: 'ingestion', organizationId: c.organizationId }
    )
    throw new PermanentFailure('processing_failed')
  }
  for (let attempt = 0; attempt < SETTINGS_ATTEMPTS; attempt++) {
    const outcome = await inTransaction(deps, c.organizationId, async (run) => {
      const upsert = (
        await run(INDEX_SETTINGS_UPSERT, [c.organizationId, embedder.model, embedder.dimensions])
      ).rows[0]
      if (upsert === undefined) {
        return 'refused' as const
      }
      const mark = (await run(INDEX_VECTORS_MARK, [c.organizationId])).rows[0]
      if (mark === undefined) {
        return 'again' as const
      }
      return mark.embedding_model === embedder.model &&
        Number(mark.embedding_dimension) === embedder.dimensions
        ? ('ok' as const)
        : ('refused' as const)
    })
    if (outcome === 'ok') {
      return
    }
    if (outcome === 'refused') {
      // The Organization's index was built with another model or dimension: a person must decide.
      reportWorkerError(
        deps,
        new Error("the embedder does not match the Organization's recorded index settings"),
        { worker: 'ingestion', organizationId: c.organizationId }
      )
      throw new PermanentFailure('processing_failed')
    }
  }
  throw new Error('the index settings kept changing')
}

/** Embed step: embed the chunks in batches and write each batch's vectors, recording progress after each. */
async function embedStep(c: JobContext): Promise<void> {
  const { deps } = c
  const { env, embedder } = deps
  const { chunks } = await readArtifact(c, chunksKey(c.documentId, c.epoch), (value) => {
    const result = chunksArtifactSchema.safeParse(value)
    return result.success ? result.data : undefined
  })
  if (c.progress.chunkCount !== null && c.progress.chunkCount !== chunks.length) {
    throw new PermanentFailure('processing_failed')
  }
  await ensureIndexSettings(c)
  for (let start = c.progress.chunksDone; start < chunks.length; start += MAX_EMBED_TEXTS) {
    c.signal.throwIfAborted()
    const batch = chunks.slice(start, start + MAX_EMBED_TEXTS)
    const vectors = await within(
      deps,
      'embedder',
      env.INGESTION_IO_TIMEOUT_MS,
      c.signal,
      (signal) =>
        embedder.embed(
          batch.map((chunk) => chunk.text),
          { purpose: 'document', signal }
        )
    )
    if (vectors.length !== batch.length) {
      throw new Error('the embedder answered with the wrong number of vectors')
    }
    if (vectors.some((vector) => vector.length !== embedder.dimensions)) {
      throw new PermanentFailure('processing_failed')
    }
    // The claim must be alive when the write starts; the lease is longer than the write's deadline.
    await beat(c)
    try {
      await within(deps, 'vector store', env.INGESTION_IO_TIMEOUT_MS, c.signal, () =>
        deps.vectors.upsert(
          c.organizationId,
          batch.map((chunk, at) => ({
            id: vectorId(c.documentId, c.epoch, chunk.index),
            vector: vectors[at] ?? [],
            attributes: {
              document_id: c.documentId,
              epoch: c.epoch,
              chunk: chunk.index,
              page: chunk.page,
            },
          }))
        )
      )
    } catch (error) {
      if (error instanceof CallTimeout) {
        throw new UncertainWrite()
      }
      throw error
    }
    c.progress.chunksDone = start + batch.length
    await advance(c, 'embed', { done: c.progress.chunksDone })
  }
  await advance(c, 'index')
}

/** Index step: remove what earlier epochs of this document left behind, so a restore leaves one copy. */
async function indexStep(c: JobContext): Promise<void> {
  if (c.epoch > 0) {
    await deleteVectorsUpTo(c.deps, c.organizationId, c.documentId, c.epoch - 1, c.signal)
    await deleteArtifactsUpTo(c.deps, c.organizationId, c.documentId, c.epoch - 1, c.signal)
  }
  await within(c.deps, 'object store', c.deps.env.INGESTION_IO_TIMEOUT_MS, c.signal, () =>
    c.deps.objects.delete(c.organizationId, pagesKey(c.documentId, c.epoch))
  )
}

/** Runs the steps from the one the job recorded. */
async function runSteps(c: JobContext, from: Step): Promise<void> {
  const document = await readDocument(c)
  if (document === undefined || document.epoch !== c.epoch) {
    throw new ClaimLost()
  }
  const order: Step[] = ['parse', 'chunk', 'embed', 'index']
  for (const step of order.slice(order.indexOf(from))) {
    c.signal.throwIfAborted()
    if (step === 'parse') {
      await parseStep(c, document.detectedType)
    } else if (step === 'chunk') {
      await chunkStep(c)
    } else if (step === 'embed') {
      await embedStep(c)
    } else {
      await indexStep(c)
    }
  }
  const done = await inTransaction(c.deps, c.organizationId, (run) =>
    run(INGESTION_JOB_COMPLETE, [c.organizationId, c.jobId, c.token])
  )
  if (done.rows.length === 0) {
    c.lost.abort(new ClaimLost())
    throw new ClaimLost()
  }
}

const STEPS: readonly string[] = ['parse', 'chunk', 'embed', 'index']

/**
 * Runs one claimed job to the end of what this claim can do, and settles it: completed, failed
 * with a contract reason, queued again after a transient failure (jittered backoff, bounded by
 * `INGESTION_MAX_ATTEMPTS`), given back on shutdown, or abandoned when the claim is lost. It
 * never throws: whatever goes wrong is settled or logged. After the claim is lost, or the lease
 * timer cannot renew it, no vector is written.
 */
export async function runJob(
  deps: PipelineDeps,
  organizationId: string,
  job: ClaimedIngestionJob,
  shutdown: AbortSignal
): Promise<JobOutcome> {
  const started = deps.clock.now().getTime()
  const lost = new AbortController()
  const context: JobContext = {
    deps,
    organizationId,
    jobId: job.id,
    documentId: job.document_id,
    epoch: job.epoch ?? 0,
    token: job.claim_token ?? '',
    signal: AbortSignal.any([shutdown, lost.signal]),
    lost,
    progress: { chunkCount: job.chunk_count, chunksDone: job.chunks_done ?? 0 },
  }
  const heartbeat = startHeartbeat(context)
  let outcome: JobOutcome
  try {
    const from = STEPS.includes(job.step ?? '') ? (job.step as Step) : 'parse'
    await runSteps(context, from)
    outcome = 'completed'
  } catch (error) {
    outcome = await settle(context, job, error, shutdown)
  } finally {
    await heartbeat.stop()
  }
  deps.logger.info('an ingestion job ended', {
    organizationId,
    documentId: job.document_id,
    jobId: job.id,
    outcome,
    attempts: job.attempts,
    chunksDone: context.progress.chunksDone,
    durationMs: deps.clock.now().getTime() - started,
  })
  return outcome
}

/** Decides what a failed run means for the job and records it. */
async function settle(
  c: JobContext,
  job: ClaimedIngestionJob,
  error: unknown,
  shutdown: AbortSignal
): Promise<JobOutcome> {
  const { deps } = c
  try {
    if (c.lost.signal.aborted || error instanceof ClaimLost) {
      return 'lost'
    }
    if (shutdown.aborted || error instanceof ShuttingDown) {
      const released = await inTransaction(deps, c.organizationId, (run) =>
        run(INGESTION_JOB_RETRY, [c.organizationId, c.jobId, c.token, 0])
      )
      return released.rows.length > 0 ? 'released' : 'lost'
    }
    if (error instanceof UncertainWrite) {
      deps.logger.warn('a vector write timed out; the job is left for its lease to lapse', {
        organizationId: c.organizationId,
        jobId: c.jobId,
      })
      return 'uncertain'
    }
    if (isCancellation(error)) {
      return 'lost'
    }
    const reason = failureReasonOf(error)
    const attempts = job.attempts ?? 1
    if (reason !== undefined || attempts >= deps.env.INGESTION_MAX_ATTEMPTS) {
      const final: DocumentFailureReason = reason ?? 'processing_failed'
      if (reason === undefined) {
        reportWorkerError(deps, error, { worker: 'ingestion', organizationId: c.organizationId })
      }
      const failed = await inTransaction(deps, c.organizationId, (run) =>
        run(INGESTION_JOB_FAIL, [c.organizationId, c.jobId, c.token, final])
      )
      deps.logger.info('an ingestion job failed', {
        organizationId: c.organizationId,
        documentId: c.documentId,
        jobId: c.jobId,
        reason: final,
      })
      return failed.rows.length > 0 ? 'failed' : 'lost'
    }
    deps.logger.warn('an ingestion attempt failed; it will be retried', {
      organizationId: c.organizationId,
      documentId: c.documentId,
      jobId: c.jobId,
      attempts,
      error: error instanceof Error ? error.name : 'unknown',
    })
    const retried = await inTransaction(deps, c.organizationId, (run) =>
      run(INGESTION_JOB_RETRY, [c.organizationId, c.jobId, c.token, retryDelayMs(deps, attempts)])
    )
    return retried.rows.length > 0 ? 'retried' : 'lost'
  } catch (settleError) {
    // The database could not be told: the lease lapses and the job is claimed again.
    reportWorkerError(deps, settleError, { worker: 'ingestion', organizationId: c.organizationId })
    return 'uncertain'
  }
}

/** The failure reason a permanent error maps to, or `undefined` when the error is worth another attempt. */
function failureReasonOf(error: unknown): DocumentFailureReason | undefined {
  if (error instanceof ParseError) {
    return error.reason
  }
  if (error instanceof PermanentFailure) {
    return error.reason
  }
  return isPermanent(error) ? 'processing_failed' : undefined
}
