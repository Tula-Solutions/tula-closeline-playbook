import type { DocumentFailureReason } from 'tula-closeline-contract'
import { formatId } from 'tula-closeline-contract'
import { StorageError, VectorError } from 'tula-closeline-kit'
import type { Run } from '~/adapters/postgres/processed-store'
import { retryTransaction } from '~/adapters/postgres/retry'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'

/** What the pipeline (the job loop, the cleanup, the sweeps) needs from the container. */
export type PipelineDeps = Pick<
  Container,
  | 'scope'
  | 'discover'
  | 'objects'
  | 'vectors'
  | 'embedder'
  | 'parser'
  | 'ocr'
  | 'logger'
  | 'clock'
  | 'env'
  | 'sleep'
  | 'random'
  | 'reportError'
>

/** The most epochs below the current one a cleanup looks at; older vectors are left to the search-time state check. */
export const MAX_STALE_EPOCHS = 64

/** How long after a delete the database counts a missing vector cleanup as pending (its `cleanup_pending` rule: five minutes). */
export const CLEANUP_PENDING_AFTER_MS = 5 * 60 * 1000

/** The statement every claim and sweep transaction starts with, so a held document row answers fast. */
export const CLAIM_LOCK_TIMEOUT_SQL = "set local lock_timeout = '1s'"

/** The object key of a document's original file (round A's rule: documents/<id>/original.<type>). */
export function originalKey(documentId: string, detectedType: string): string {
  return `documents/${documentId}/original.${detectedType}`
}

/** The object key of the parsed pages of one ingestion (resume point after the parse step). */
export function pagesKey(documentId: string, epoch: number): string {
  return `documents/${documentId}/pages-${epoch}.json`
}

/** The object key of the chunks of one ingestion: the text behind the vectors, indexed by chunk number. */
export function chunksKey(documentId: string, epoch: number): string {
  return `documents/${documentId}/chunks-${epoch}.json`
}

/** The prefix under which every object of one document lives. */
export function documentPrefix(documentId: string): string {
  return `documents/${documentId}/`
}

/**
 * The vector id of a chunk: the document, the epoch of the ingestion and the chunk number. It is
 * deterministic, so a resumed job overwrites instead of duplicating, and the epoch in it keeps a
 * restore's vectors apart from the earlier ones. At most 36 + 1 + 10 + 1 + 7 characters, under the
 * store's 64.
 */
export function vectorId(documentId: string, epoch: number, chunk: number): string {
  return `${documentId}:${epoch}:${chunk}`
}

/** A job that cannot succeed by trying again: it ends `failed` with this reason. */
export class PermanentFailure extends Error {
  readonly reason: DocumentFailureReason
  /** Creates the failure; the message never holds content. */
  constructor(reason: DocumentFailureReason, message = `ingestion failed: ${reason}`) {
    super(message)
    this.name = 'PermanentFailure'
    this.reason = reason
  }
}

/** The job lost its claim (the document was deleted, or the lease lapsed): stop and write nothing. */
export class ClaimLost extends Error {
  /** Creates the signal. */
  constructor() {
    super('the ingestion job lost its claim')
    this.name = 'ClaimLost'
  }
}

/** The worker is shutting down: stop at this step boundary. */
export class ShuttingDown extends Error {
  /** Creates the signal. */
  constructor() {
    super('the worker is shutting down')
    this.name = 'ShuttingDown'
  }
}

/** A call ran out of time. A write that timed out may still land, so the caller treats it as uncertain. */
export class CallTimeout extends Error {
  /** Creates the error. */
  constructor(readonly label: string) {
    super(`a call to ${label} ran out of time`)
    this.name = 'CallTimeout'
  }
}

/** Whether `error` came from a call that was cancelled on purpose (shutdown or a lost claim). */
export function isCancellation(error: unknown): boolean {
  return error instanceof ClaimLost || error instanceof ShuttingDown
}

/**
 * Runs `fn` with a deadline and a cancel signal. `fn` receives a signal that aborts when `signal`
 * does or when `timeoutMs` has passed. A port that does not take a signal (the object store, the
 * vector store) cannot be interrupted, so the call is raced against the deadline and the signal
 * and its late result is dropped. Rejects with {@link CallTimeout} on the deadline, with the
 * signal's reason on a cancel.
 */
export async function within<T>(
  deps: Pick<PipelineDeps, 'sleep'>,
  label: string,
  timeoutMs: number,
  signal: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  const control = new AbortController()
  const link = () => control.abort(signal.reason)
  signal.addEventListener('abort', link, { once: true })
  let timedOut = false
  const timer = new AbortController()
  const deadline = deps.sleep(timeoutMs, timer.signal).then(() => {
    if (!timer.signal.aborted) {
      timedOut = true
      control.abort(new CallTimeout(label))
    }
  })
  const cancelled = new Promise<never>((_, reject) => {
    control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true })
  })
  try {
    const work = fn(control.signal)
    // A rejection after the race is over is not an unhandled one.
    work.catch(() => undefined)
    return await Promise.race([work, cancelled])
  } catch (error) {
    if (timedOut) {
      throw new CallTimeout(label)
    }
    throw error
  } finally {
    timer.abort()
    signal.removeEventListener('abort', link)
    await deadline
    cancelled.catch(() => undefined)
  }
}

/** Runs one Organization-scoped transaction, again from the start after a deadlock or serialization failure. */
export function inTransaction<T>(
  deps: Pick<PipelineDeps, 'scope' | 'sleep' | 'random'>,
  organizationId: string,
  work: (run: Run) => Promise<T>
): Promise<T> {
  return retryTransaction(() => deps.scope(organizationId, work), {
    sleep: (ms) => deps.sleep(ms),
    random: deps.random,
  })
}

/** A wait of about `ms`: between three quarters and the whole, so instances spread out. */
export function jittered(deps: Pick<PipelineDeps, 'random'>, ms: number): number {
  return Math.floor(ms * (0.75 + deps.random() * 0.25))
}

/** The delay before the retry that follows the `attempts`-th claim: doubling from the base, ten minutes at most, equal jitter. */
export function retryDelayMs(deps: Pick<PipelineDeps, 'random' | 'env'>, attempts: number): number {
  const ceiling = Math.min(
    deps.env.INGESTION_RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0),
    600_000
  )
  return Math.floor(ceiling / 2 + (deps.random() * ceiling) / 2)
}

/**
 * Whether trying again cannot help: a request the stores refuse as malformed or reject outright (access denied,
 * wrong index), a vector of the wrong length, an object over the limit. Everything else (timeouts, unavailable, a bad answer,
 * a database error) is worth another attempt, bounded by the attempt limit.
 */
export function isPermanent(error: unknown): boolean {
  if (error instanceof PermanentFailure) {
    return true
  }
  if (error instanceof VectorError) {
    return (
      error.code === 'vector.invalid_request' ||
      error.code === 'vector.dimension_mismatch' ||
      error.code === 'vector.rejected'
    )
  }
  if (error instanceof StorageError) {
    return error.code === 'storage.invalid_request' || error.code === 'storage.object_too_large'
  }
  return false
}

/** Reports an unexpected worker error: a log line with the error described and ids, never content. */
export function reportWorkerError(
  deps: Pick<PipelineDeps, 'logger' | 'reportError'>,
  error: unknown,
  where: { worker: string; organizationId?: string }
): void {
  deps.logger.error('a worker step failed', {
    worker: where.worker,
    ...(where.organizationId === undefined ? {} : { organizationId: where.organizationId }),
    error: describeError(error),
  })
  try {
    deps.reportError(error, {
      requestId: formatId('req', crypto.randomUUID()),
      ...(where.organizationId === undefined ? {} : { organizationId: where.organizationId }),
      method: 'WORKER',
      path: where.worker,
      status: 500,
    })
  } catch {
    // A failing reporter must not stop a worker.
  }
}
