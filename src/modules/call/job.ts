import { type CallFailureReason, MAX_TRANSCRIPT_BYTES } from 'tula-closeline-contract'
import {
  CALL_GET,
  CALL_JOB_COMPLETE,
  CALL_JOB_FAIL,
  CALL_JOB_HEARTBEAT,
  CALL_JOB_RECORD,
  CALL_JOB_RETRY,
  type ClaimedCallJob,
  DEAL_GET,
} from 'tula-closeline-db'
import { ensureIndexSettings } from '~/modules/ingestion/job'
import {
  CallTimeout,
  ClaimLost,
  inTransaction,
  isCancellation,
  isPermanent,
  PermanentFailure,
  type PipelineDeps,
  reportWorkerError,
  retryDelayMs,
  ShuttingDown,
  within,
} from '~/modules/ingestion/runtime'
import { MAX_EMBED_TEXTS } from '~/ports/embedder'
import { momentVectorId } from './keys'
import { buildMoments } from './moments'
import { parseTranscript, type TranscriptMediaType } from './transcript'

/** The most epochs below the current one a Call's cleanup looks at, as for documents. */
const MAX_STALE_EPOCHS = 64

/** How a Call job's run ended. */
export type CallJobOutcome =
  /** The Call is `ready` and its Moments are in the vector store. */
  | 'completed'
  /** The Call ended `failed` with a reason. */
  | 'failed'
  /** A transient failure; the job is due again after a delay. */
  | 'retried'
  /** The claim was lost (the Call was deleted, changed or erased, or the lease lapsed); nothing more was written. */
  | 'lost'
  /** Shutdown: the job was given back and is due at once. */
  | 'released'
  /** The database or the vector store could not be told how it ended; the lease lapses and the job is claimed again. */
  | 'uncertain'

/** A Transcript that cannot be processed by trying again: the Call ends `failed` with this reason. */
class CallFailure extends Error {
  constructor(readonly reason: CallFailureReason) {
    super(`the Call failed: ${reason}`)
    this.name = 'CallFailure'
  }
}

/** A vector write that timed out: it may still land, so the claim is left to lapse rather than renewed. */
class UncertainWrite extends Error {
  constructor() {
    super('a vector write ran out of time and may still land')
    this.name = 'UncertainWrite'
  }
}

/** What every step of one run needs. */
type CallJobContext = {
  deps: PipelineDeps
  organizationId: string
  jobId: string
  callId: string
  epoch: number
  repSeq: number
  token: string
  /** Aborts on shutdown or on a lost claim: pass it to every call. */
  signal: AbortSignal
  lost: AbortController
  /** Vector writes started and not yet answered; a write the caller gave up on may still land. */
  writesInFlight: number
}

/** Renews the lease once; false means the claim is gone. */
async function heartbeatOnce(c: CallJobContext): Promise<boolean> {
  const { deps } = c
  const result = await inTransaction(deps, c.organizationId, (run) =>
    run(CALL_JOB_HEARTBEAT, [c.organizationId, c.jobId, c.token, deps.env.INGESTION_LEASE_MS])
  )
  return result.rows.length > 0
}

/** Confirms the claim is alive right now; throws {@link ClaimLost} (and stops every call) when it is not. */
async function beat(c: CallJobContext): Promise<void> {
  c.signal.throwIfAborted()
  if (!(await heartbeatOnce(c))) {
    c.lost.abort(new ClaimLost())
    throw new ClaimLost()
  }
}

/** Renews the lease on a timer while the run works; a quiet database for most of a lease ends the run. */
function startHeartbeat(c: CallJobContext): { stop: () => Promise<void> } {
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
        deps.logger.warn('a Call job heartbeat failed', {
          organizationId: c.organizationId,
          callId: c.callId,
          error: error instanceof Error ? error.name : 'unknown',
        })
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

/** Reads the Transcript's object (at most the Transcript limit); a missing object is a loss, not a fault of the file. */
async function readTranscript(c: CallJobContext, objectKey: string): Promise<Uint8Array> {
  const { deps } = c
  const object = await within(
    deps,
    'object store',
    deps.env.INGESTION_IO_TIMEOUT_MS,
    c.signal,
    () => deps.objects.get(c.organizationId, objectKey)
  )
  if (object === undefined) {
    // The upload stores the file before it inserts the row, so a row without a file is a loss.
    throw new CallFailure('processing_failed')
  }
  if (object.body.byteLength > MAX_TRANSCRIPT_BYTES) {
    throw new CallFailure('unreadable')
  }
  return object.body
}

/** The Outcome and Outcome sequence of the Call's Deal now, for the vectors' tag. */
async function readDealOutcome(
  c: CallJobContext
): Promise<{ outcome: string; outcomeSeq: number }> {
  const { deps } = c
  return inTransaction(deps, c.organizationId, async (run) => {
    const call = (await run(CALL_GET, [c.organizationId, c.callId])).rows[0]
    if (call === undefined) {
      throw new ClaimLost()
    }
    const deal = (await run(DEAL_GET, [c.organizationId, String(call.deal_record_id)])).rows[0]
    if (deal === undefined) {
      throw new ClaimLost()
    }
    return { outcome: String(deal.outcome), outcomeSeq: Number(deal.outcome_seq) }
  })
}

/** Deletes the Call's vectors of earlier epochs, one filter per epoch (equality filters only), the newest {@link MAX_STALE_EPOCHS}. */
async function deleteEarlierEpochs(c: CallJobContext): Promise<void> {
  const { deps } = c
  const from = Math.max(0, c.epoch - MAX_STALE_EPOCHS)
  for (let epoch = from; epoch < c.epoch; epoch++) {
    await within(deps, 'vector store', deps.env.INGESTION_IO_TIMEOUT_MS, c.signal, () =>
      deps.vectors.deleteByFilter(c.organizationId, { call_id: c.callId, epoch })
    )
  }
}

/** Embeds the Moments in batches and writes each batch's vectors, tagged with the Deal's Outcome as read. */
async function writeMoments(
  c: CallJobContext,
  moments: readonly { index: number; text: string }[],
  tag: { outcome: string; outcomeSeq: number }
): Promise<void> {
  const { deps } = c
  const { env, embedder } = deps
  for (let start = 0; start < moments.length; start += MAX_EMBED_TEXTS) {
    c.signal.throwIfAborted()
    const batch = moments.slice(start, start + MAX_EMBED_TEXTS)
    const vectors = await within(
      deps,
      'embedder',
      env.INGESTION_IO_TIMEOUT_MS,
      c.signal,
      (signal) =>
        embedder.embed(
          batch.map((moment) => moment.text),
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
      await within(deps, 'vector store', env.INGESTION_IO_TIMEOUT_MS, c.signal, () => {
        const write = deps.vectors.upsert(
          c.organizationId,
          batch.map((moment, at) => ({
            id: momentVectorId(c.callId, c.epoch, c.repSeq, moment.index),
            vector: vectors[at] ?? [],
            attributes: {
              call_id: c.callId,
              epoch: c.epoch,
              rep_seq: c.repSeq,
              moment: moment.index,
              outcome: tag.outcome,
              outcome_seq: tag.outcomeSeq,
            },
          }))
        )
        // Counted until the store itself answers, not until the caller stops waiting.
        c.writesInFlight++
        const done = () => {
          c.writesInFlight--
        }
        write.then(done, done)
        return write
      })
    } catch (error) {
      if (error instanceof CallTimeout) {
        throw new UncertainWrite()
      }
      throw error
    }
  }
}

/** Parses, records the speakers, builds and writes the Moments, and completes the Call. */
async function runSteps(c: CallJobContext, claim: ClaimedCallJob): Promise<void> {
  const { deps } = c
  if (
    claim.job_kind !== 'process' ||
    claim.call_kind !== 'transcript' ||
    claim.object_key === null
  ) {
    // Recordings and Rep rebuilds are later work; a job of another kind is not run by this code.
    throw new CallFailure('processing_failed')
  }
  const bytes = await readTranscript(c, claim.object_key)
  const parsed = parseTranscript(bytes, (claim.media_type ?? 'text/plain') as TranscriptMediaType)
  if (!parsed.ok) {
    throw new CallFailure(parsed.reason)
  }
  const { turns, speakers } = parsed.transcript
  if (claim.rep_by !== 'speaker' || claim.rep_label === null) {
    throw new CallFailure('rep_label_not_found')
  }
  if (!speakers.includes(claim.rep_label)) {
    throw new CallFailure('rep_label_not_found')
  }
  const recorded = await inTransaction(deps, c.organizationId, (run) =>
    run(CALL_JOB_RECORD, [
      c.organizationId,
      c.jobId,
      c.token,
      null,
      null,
      speakers,
      deps.env.INGESTION_LEASE_MS,
    ])
  )
  if (recorded.rows.length === 0) {
    c.lost.abort(new ClaimLost())
    throw new ClaimLost()
  }
  const moments = buildMoments(turns, claim.rep_label)
  const tag = await readDealOutcome(c)
  if (moments.length > 0) {
    await ensureIndexSettings(deps, c.organizationId)
    await writeMoments(c, moments, tag)
  }
  if (c.epoch > 0) {
    await deleteEarlierEpochs(c)
  }
  await beat(c)
  // The completion runs in its own short transaction, after every external write.
  const done = await inTransaction(deps, c.organizationId, (run) =>
    run(CALL_JOB_COMPLETE, [c.organizationId, c.jobId, c.token, tag.outcomeSeq])
  )
  if (done.rows.length === 0) {
    c.lost.abort(new ClaimLost())
    throw new ClaimLost()
  }
}

/**
 * Runs one claimed Call job to the end of what this claim can do, and settles it: completed, failed
 * with a contract reason, queued again after a transient failure (jittered backoff, bounded by
 * `INGESTION_MAX_ATTEMPTS`), given back on shutdown, or abandoned when the claim is lost. It never
 * throws. Nothing it logs holds Transcript text, a speaker label, a file name or a customer deal
 * id: ids, counts and durations only.
 */
export async function runCallJob(
  deps: PipelineDeps,
  organizationId: string,
  claim: ClaimedCallJob,
  shutdown: AbortSignal
): Promise<CallJobOutcome> {
  const started = deps.clock.now().getTime()
  const lost = new AbortController()
  const context: CallJobContext = {
    deps,
    organizationId,
    jobId: claim.id,
    callId: claim.call_id,
    epoch: claim.epoch ?? 0,
    repSeq: claim.rep_seq ?? 0,
    token: claim.claim_token ?? '',
    signal: AbortSignal.any([shutdown, lost.signal]),
    lost,
    writesInFlight: 0,
  }
  const heartbeat = startHeartbeat(context)
  let outcome: CallJobOutcome
  try {
    await runSteps(context, claim)
    outcome = 'completed'
  } catch (error) {
    outcome = await settle(context, claim, error, shutdown)
  } finally {
    await heartbeat.stop()
  }
  deps.logger.info('a Call job ended', {
    organizationId,
    callId: claim.call_id,
    jobId: claim.id,
    outcome,
    attempts: claim.attempts,
    durationMs: deps.clock.now().getTime() - started,
  })
  return outcome
}

/** The failure reason a permanent error maps to, or `undefined` when the error is worth another attempt. */
function failureReasonOf(error: unknown): CallFailureReason | undefined {
  if (error instanceof CallFailure) {
    return error.reason
  }
  if (error instanceof PermanentFailure) {
    return 'processing_failed'
  }
  return isPermanent(error) ? 'processing_failed' : undefined
}

/** Decides what a failed run means for the job and records it. */
async function settle(
  c: CallJobContext,
  claim: ClaimedCallJob,
  error: unknown,
  shutdown: AbortSignal
): Promise<CallJobOutcome> {
  const { deps } = c
  try {
    if (c.lost.signal.aborted || error instanceof ClaimLost) {
      return 'lost'
    }
    if (c.writesInFlight > 0 || error instanceof UncertainWrite) {
      // A write the store has not answered may still land. Releasing the job would clear the lease
      // that fences a delete's cleanup, so the job stays running until its lease lapses.
      deps.logger.warn('a vector write was interrupted; the job is left for its lease to lapse', {
        organizationId: c.organizationId,
        callId: c.callId,
      })
      return 'uncertain'
    }
    if (shutdown.aborted || error instanceof ShuttingDown) {
      const released = await inTransaction(deps, c.organizationId, (run) =>
        run(CALL_JOB_RETRY, [c.organizationId, c.jobId, c.token, 0])
      )
      return released.rows.length > 0 ? 'released' : 'lost'
    }
    if (isCancellation(error)) {
      return 'lost'
    }
    const reason = failureReasonOf(error)
    const attempts = claim.attempts ?? 1
    if (reason !== undefined || attempts >= deps.env.INGESTION_MAX_ATTEMPTS) {
      const final: CallFailureReason = reason ?? 'processing_failed'
      if (reason === undefined) {
        reportWorkerError(deps, error, { worker: 'calls', organizationId: c.organizationId })
      }
      const failed = await inTransaction(deps, c.organizationId, (run) =>
        run(CALL_JOB_FAIL, [c.organizationId, c.jobId, c.token, final])
      )
      deps.logger.info('a Call failed', {
        organizationId: c.organizationId,
        callId: c.callId,
        jobId: c.jobId,
        reason: final,
      })
      return failed.rows.length > 0 ? 'failed' : 'lost'
    }
    deps.logger.warn('a Call job attempt failed; it will be retried', {
      organizationId: c.organizationId,
      callId: c.callId,
      jobId: c.jobId,
      attempts,
      error: error instanceof Error ? error.name : 'unknown',
    })
    const retried = await inTransaction(deps, c.organizationId, (run) =>
      run(CALL_JOB_RETRY, [c.organizationId, c.jobId, c.token, retryDelayMs(deps, attempts)])
    )
    return retried.rows.length > 0 ? 'retried' : 'lost'
  } catch (settleError) {
    // The database could not be told: the lease lapses and the job is claimed again.
    reportWorkerError(deps, settleError, { worker: 'calls', organizationId: c.organizationId })
    return 'uncertain'
  }
}
