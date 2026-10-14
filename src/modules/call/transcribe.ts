import {
  type CallFailureReason,
  formatId,
  MAX_CALL_SPEAKERS,
  MAX_RECORDING_SECONDS,
  MAX_TRANSCRIPT_BYTES,
  speakerLabelSchema,
} from 'tula-closeline-contract'
import {
  CALL_JOB_MAX_ATTEMPTS,
  CALL_JOB_RECORD,
  CALL_JOB_TRANSCRIBED,
  CALL_SENT_TO_VENDOR,
  CALL_VENDOR_ID_RECORD,
  type ClaimedCallJob,
} from 'tula-closeline-db'
import {
  MAX_SPEAKERS,
  type TranscriptionFailure,
  type TranscriptionResult,
  type TranscriptTurn,
} from 'tula-closeline-kit'
import { postgresErrorOf } from '~/adapters/postgres/retry'
import { toTextArrayLiteral } from '~/adapters/postgres/text-array'
import {
  ClaimLost,
  inTransaction,
  jittered,
  type PipelineDeps,
  within,
} from '~/modules/ingestion/runtime'
import { CallFailure } from './failure'
import {
  clientReferenceOf,
  clientReferencePrefix,
  recordingTranscriptKey,
  sendOfReference,
} from './keys'
import { parseTranscript } from './transcript'

/** How long the presigned URL handed to the vendor stays valid, in seconds. The vendor fetches within minutes; a retry signs a new one. */
export const AUDIO_URL_SECONDS = 300

/** The pages of the vendor's list one adoption of an earlier copy reads, so a runaway listing ends. */
const MAX_LIST_PAGES = 20

/** What a transcribe step needs to know about its job. */
export type TranscribeContext = {
  deps: PipelineDeps
  organizationId: string
  jobId: string
  callId: string
  token: string
  /** Aborts on shutdown or on a lost claim: pass it to every call. */
  signal: AbortSignal
  /** Confirms the claim is alive right now; throws when it is not. */
  beat: () => Promise<void>
}

/** The failure reason a vendor's `failed` result maps to. */
const VENDOR_FAILURE: Readonly<Record<TranscriptionFailure, CallFailureReason>> = {
  audio_unreachable: 'transcription_failed',
  audio_invalid: 'unreadable',
  no_speech: 'no_turns',
  too_long: 'too_long',
  vendor_failed: 'transcription_failed',
  timed_out: 'transcription_timed_out',
}

/** The newest copy the vendor holds for this Call that has not failed: a failed send is never read again, a new counted send replaces it. */
type VendorCopy = { reference: string; seq: number; vendorId: string }

/**
 * Finds the copy of the newest send of this Call that has not failed, by listing the vendor's jobs for the Call's
 * reference prefix (a background job may; the prefix ends with the separator). A retry or a later
 * poll then reads that copy instead of paying for a second transcription.
 */
async function findNewestCopy(c: TranscribeContext): Promise<VendorCopy | undefined> {
  const { deps } = c
  let best: VendorCopy | undefined
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await within(
      deps,
      'transcriber',
      deps.env.INGESTION_IO_TIMEOUT_MS,
      c.signal,
      () =>
        deps.transcriber.list(c.organizationId, {
          prefix: clientReferencePrefix(c.callId),
          ...(cursor === undefined ? {} : { cursor }),
        })
    )
    for (const item of listed.items) {
      const seq = sendOfReference(c.callId, item.clientReference)
      if (seq !== undefined && item.status !== 'failed' && (best === undefined || seq > best.seq)) {
        best = { reference: item.clientReference, seq, vendorId: item.vendorId }
      }
    }
    cursor = listed.nextCursor
    if (cursor === undefined) {
      break
    }
  }
  return best
}

/**
 * Stores the vendor's id of send `seq`. A conflict (a different id already recorded, or one that
 * another send holds; SQLSTATE 23505 from the unique index counts as the same) or an invalid id is
 * logged by Call and send number only and the job goes on without the id as a hint: the client
 * reference still finds the copy. Returns whether the id is recorded and may be used as a hint.
 * Nothing it logs holds the id.
 */
async function recordVendorId(
  c: TranscribeContext,
  seq: number,
  vendorId: string
): Promise<boolean> {
  const { deps } = c
  let result: string | undefined
  try {
    const answer = await inTransaction(deps, c.organizationId, (run) =>
      run(CALL_VENDOR_ID_RECORD, [c.organizationId, c.callId, seq, vendorId])
    )
    result = answer.rows[0]?.result === undefined ? undefined : String(answer.rows[0].result)
  } catch (error) {
    if (postgresErrorOf(error)?.code !== '23505') {
      throw error
    }
    result = 'conflict'
  }
  if (result === 'recorded' || result === 'unchanged') {
    return true
  }
  deps.logger.warn('the vendor id of a send could not be recorded; the reference is used instead', {
    organizationId: c.organizationId,
    callId: c.callId,
    seq,
    result: result ?? 'no_send',
  })
  return false
}

/** What one look at the vendor found: the result, or that it is still working and when to look again. */
type Step =
  | { kind: 'done'; result: Extract<TranscriptionResult, { status: 'done' }> }
  | { kind: 'pending'; pollAfterMs: number }

/**
 * How long until the next look at a send that is still pending: the time already waited, at least
 * the poll interval and at most what is left of `TRANSCRIBE_MAX_WAIT_MS`, so the looks thin out
 * (a job is claimed at most {@link CALL_JOB_MAX_ATTEMPTS} times) and the last one lands on the
 * deadline. A wait that has run out fails the Call with `transcription_timed_out`.
 */
function pollDelayMs(c: TranscribeContext, claim: ClaimedCallJob, startedMs: number): number {
  const { deps } = c
  const elapsed = Math.max(0, deps.clock.now().getTime() - startedMs)
  const remaining = deps.env.TRANSCRIBE_MAX_WAIT_MS - elapsed
  if (remaining <= 0) {
    throw new CallFailure('transcription_timed_out')
  }
  const attempts = claim.attempts ?? 1
  if (attempts >= CALL_JOB_MAX_ATTEMPTS - 1) {
    // The last claim the table allows: another release would leave the job spent as
    // `processing_failed`, whatever the clocks say about the time left (the database's and ours differ).
    throw new CallFailure('transcription_timed_out')
  }
  if (attempts >= CALL_JOB_MAX_ATTEMPTS - 2) {
    // The one before: look at the deadline.
    return Math.ceil(remaining)
  }
  const base = Math.max(deps.env.TRANSCRIBE_POLL_INTERVAL_MS, elapsed)
  return Math.max(1, Math.min(jittered(deps, base), Math.ceil(remaining)))
}

/**
 * Looks at the transcriber once, sending first when it holds no copy. A send is counted before the
 * request (`CALL_SENT_TO_VENDOR`, at most 20 per Call: `sent: false` fails the Call, it is never
 * retried), carries the client reference `<call id>:<seq>`, and gets a presigned URL signed just
 * before the request. After the vendor accepts, its id is stored beside the send. A copy of an
 * earlier send (found by listing, unless `fresh`) is read instead of sending again. The job never
 * waits here: a result that is not ready is `pending`, and the caller gives the job back.
 */
async function sendAndRead(
  c: TranscribeContext,
  claim: ClaimedCallJob,
  mode: 'split_channels' | 'diarize',
  fresh: boolean
): Promise<Step> {
  const { deps } = c
  const timeout = deps.env.INGESTION_IO_TIMEOUT_MS
  if (claim.object_key === null) {
    throw new CallFailure('processing_failed')
  }
  await c.beat()
  let copy = !fresh && claim.sent_to_vendor_at !== null ? await findNewestCopy(c) : undefined
  let hint: string | undefined
  let startedMs: number
  if (copy !== undefined) {
    if (await recordVendorId(c, copy.seq, copy.vendorId)) {
      hint = copy.vendorId
    }
    const sentAt =
      claim.sent_to_vendor_at === null ? Number.NaN : new Date(claim.sent_to_vendor_at).getTime()
    startedMs = Number.isNaN(sentAt) ? deps.clock.now().getTime() : sentAt
  } else {
    const sent = await inTransaction(deps, c.organizationId, (run) =>
      run(CALL_SENT_TO_VENDOR, [c.organizationId, c.jobId, c.token])
    )
    const row = sent.rows[0]
    if (row === undefined) {
      throw new ClaimLost()
    }
    if (row.sent !== true) {
      // The 20 sends of this Call are used. Trying again would only loop until the purge.
      throw new CallFailure('transcription_failed')
    }
    const seq = Number(row.vendor_send_seq)
    const reference = clientReferenceOf(c.callId, seq)
    const objectKey = claim.object_key
    startedMs = deps.clock.now().getTime()
    // Signed as late as possible: the URL lives for the shorter of this and the credentials' life.
    const url = await within(deps, 'object store', timeout, c.signal, () =>
      deps.objects.presignGet(c.organizationId, objectKey, { expiresInSeconds: AUDIO_URL_SECONDS })
    )
    const submission = await within(deps, 'transcriber', timeout, c.signal, () =>
      deps.transcriber.submit(c.organizationId, {
        clientReference: reference,
        audio: { url },
        audioKey: `${objectKey}:${claim.size_bytes ?? 0}`,
        speakers: mode,
        ...(mode === 'diarize' ? { maxSpeakers: MAX_SPEAKERS } : {}),
      })
    )
    copy = { reference, seq, vendorId: submission.vendorId }
    if (await recordVendorId(c, seq, submission.vendorId)) {
      hint = submission.vendorId
    }
  }
  const { reference } = copy
  const result = await within(deps, 'transcriber', timeout, c.signal, () =>
    deps.transcriber.getResult(
      c.organizationId,
      reference,
      hint === undefined ? undefined : { vendorId: hint }
    )
  )
  if (result === undefined) {
    // The copy is gone (deleted at the vendor): another attempt sends again.
    throw new Error('the transcriber no longer holds the send')
  }
  if (result.status === 'failed') {
    throw new CallFailure(VENDOR_FAILURE[result.reason])
  }
  if (result.status === 'done') {
    return { kind: 'done', result }
  }
  return { kind: 'pending', pollAfterMs: pollDelayMs(c, claim, startedMs) }
}

/** The label a per-side Recording's turns carry: the channel's name. */
const CHANNEL_LABELS = ['left', 'right'] as const

/**
 * Turns the vendor's result into the Transcript the service keeps, as the bytes of a JSON array of
 * `{ speaker, text }` the Transcript parser reads, and the Call's speakers. Per-side: each channel
 * is a speaker, `left` or `right`, and a file that does not have exactly the two channels speaking
 * is `not_per_side`. Mixed (diarized): the vendor's labels. Every reason is the contract's; nothing
 * of the text appears in a failure.
 */
export function keepTranscript(
  result: Extract<TranscriptionResult, { status: 'done' }>,
  mode: 'split_channels' | 'diarize'
): { bytes: Uint8Array; speakers: string[]; durationSeconds: number } {
  const durationSeconds = Math.max(1, Math.ceil(result.durationMs / 1000))
  if (durationSeconds > MAX_RECORDING_SECONDS) {
    throw new CallFailure('too_long')
  }
  const turns: { speaker: string; text: string }[] = []
  const channels = new Set<number>()
  for (const turn of result.turns as readonly TranscriptTurn[]) {
    let speaker: string
    if (mode === 'split_channels') {
      const label = turn.channel === undefined ? undefined : CHANNEL_LABELS[turn.channel]
      if (label === undefined || turn.channel === undefined) {
        throw new CallFailure('not_per_side')
      }
      channels.add(turn.channel)
      speaker = label
    } else {
      const label = speakerLabelSchema.safeParse(turn.speaker)
      if (!label.success) {
        throw new CallFailure('unreadable')
      }
      speaker = label.data
    }
    turns.push({ speaker, text: turn.text })
  }
  if (mode === 'split_channels' && turns.length > 0 && channels.size !== 2) {
    throw new CallFailure('not_per_side')
  }
  const bytes = new TextEncoder().encode(JSON.stringify(turns))
  if (bytes.byteLength > MAX_TRANSCRIPT_BYTES) {
    throw new CallFailure('unreadable')
  }
  const parsed = parseTranscript(bytes, 'application/json')
  if (!parsed.ok) {
    throw new CallFailure(parsed.reason)
  }
  if (parsed.transcript.speakers.length > MAX_CALL_SPEAKERS) {
    throw new CallFailure('too_many_speakers')
  }
  return { bytes, speakers: parsed.transcript.speakers, durationSeconds }
}

/**
 * Whether a result is the diarized copy a per-side Recording falls back to: the Rep was declared by
 * channel, yet the turns carry no channel. Derived from the data, so a retry that finds only that
 * copy knows what it is without any state of its own.
 */
function isDiarizedFallback(
  claim: ClaimedCallJob,
  result: Extract<TranscriptionResult, { status: 'done' }>
): boolean {
  return (
    claim.rep_by === 'channel' &&
    result.turns.length > 0 &&
    result.turns.every((turn) => turn.channel === undefined)
  )
}

/**
 * The whole transcribe job. When no Transcript is kept yet it looks at the vendor once (sending
 * first if there is no copy) and either keeps the Transcript under the Call's prefix and records it
 * with its duration and speakers (`CALL_JOB_RECORD`), or, when the vendor is still working, returns
 * how long until the next look: the caller gives the job back for that long, so a job never holds a
 * worker while the vendor works. Then `CALL_JOB_TRANSCRIBED` moves the Call to `awaiting_rep`
 * (mono, no Rep chosen) or `processing` with a queued process job, the same Moment path as a
 * Transcript. A crash between the two statements leaves the kept Transcript, so the retry only
 * finishes. Idempotent at every step.
 *
 * A Recording declared per-side whose file is not (a channel that never speaks) is sent once more
 * as a diarized transcription; its Transcript and speaker labels are kept and the Call then fails
 * `not_per_side`, so a Rep change to one of the speakers rebuilds the Moments.
 */
export async function runTranscribe(
  c: TranscribeContext,
  claim: ClaimedCallJob
): Promise<{ pollAfterMs: number } | undefined> {
  const { deps } = c
  if (claim.call_kind !== 'recording' || claim.object_key === null) {
    throw new CallFailure('processing_failed')
  }
  let notPerSide = false
  if (claim.transcript_key === null) {
    // Declared per-side: the channels are the speakers. Otherwise the vendor separates them.
    const mode = claim.rep_by === 'channel' ? 'split_channels' : 'diarize'
    let step = await sendAndRead(c, claim, mode, false)
    if (step.kind === 'pending') {
      return { pollAfterMs: step.pollAfterMs }
    }
    let kept: ReturnType<typeof keepTranscript>
    if (mode === 'split_channels' && isDiarizedFallback(claim, step.result)) {
      kept = keepTranscript(step.result, 'diarize')
      notPerSide = true
    } else {
      try {
        kept = keepTranscript(step.result, mode)
      } catch (error) {
        if (!(error instanceof CallFailure) || error.reason !== 'not_per_side') {
          throw error
        }
        // Not per-side after all. Keep the speakers a Rep can be picked from before failing.
        step = await sendAndRead(c, claim, 'diarize', true)
        if (step.kind === 'pending') {
          return { pollAfterMs: step.pollAfterMs }
        }
        kept = keepTranscript(step.result, 'diarize')
        notPerSide = true
      }
    }
    const key = recordingTranscriptKey(c.callId)
    await within(deps, 'object store', deps.env.INGESTION_IO_TIMEOUT_MS, c.signal, () =>
      deps.objects.put(c.organizationId, key, kept.bytes, { contentType: 'application/json' })
    )
    const recorded = await inTransaction(deps, c.organizationId, (run) =>
      run(CALL_JOB_RECORD, [
        c.organizationId,
        c.jobId,
        c.token,
        key,
        kept.durationSeconds,
        toTextArrayLiteral(kept.speakers),
        deps.env.INGESTION_LEASE_MS,
      ])
    )
    if (recorded.rows.length === 0) {
      throw new ClaimLost()
    }
    if (notPerSide) {
      throw new CallFailure('not_per_side')
    }
  }
  await c.beat()
  const moved = await inTransaction(deps, c.organizationId, (run) =>
    run(CALL_JOB_TRANSCRIBED, [
      c.organizationId,
      c.jobId,
      c.token,
      formatId('cjob', crypto.randomUUID()),
    ])
  )
  if (moved.rows.length === 0) {
    throw new ClaimLost()
  }
  return undefined
}
