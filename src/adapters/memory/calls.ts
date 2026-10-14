import {
  CALL_CLEANUP_BEGIN,
  CALL_CLEANUP_DONE,
  CALL_ERASE_BATCH,
  CALL_GET,
  CALL_INSERT,
  CALL_JOB_CLAIM,
  CALL_JOB_COMPLETE,
  CALL_JOB_FAIL,
  CALL_JOB_GIVE_UP_SPENT,
  CALL_JOB_HEARTBEAT,
  CALL_JOB_MAX_ATTEMPTS,
  CALL_JOB_RECORD,
  CALL_JOB_RETRY,
  CALL_JOB_TRANSCRIBED,
  CALL_LIST,
  CALL_LIST_BY_DEAL,
  CALL_LIST_BY_DEAL_STATE,
  CALL_LIST_BY_STATE,
  CALL_LIST_PENDING_CLEANUP,
  CALL_LIST_SPENT_PURGES,
  CALL_MAX_VENDOR_SENDS,
  CALL_PURGE_CLAIM,
  CALL_PURGE_COMPLETE,
  CALL_PURGE_MAX_ATTEMPTS,
  CALL_REQUEUE,
  CALL_RESTORE,
  CALL_RESTORE_FOR_UPLOAD,
  CALL_RETAGGED,
  CALL_SENT_TO_VENDOR,
  CALL_SET_REP,
  CALL_SOFT_DELETE,
  CALL_USAGE,
  CALL_VENDOR_ID_PATTERN,
  CALL_VENDOR_ID_RECORD,
  CALL_VENDOR_REMOVED,
  DEAL_LIST_PENDING_RETAG,
  DEAL_RETAG_BATCH,
  DEAL_RETAG_DONE,
  DEAL_RETAG_LOCK,
  INGESTION_MAX_RETRY_DELAY_MS,
  PLAYBOOK_MIN_LEASE_MS,
} from 'tula-closeline-db'
import type { Result } from '~/adapters/postgres/processed-store'
import { parseTextArrayLiteral } from '~/adapters/postgres/text-array'
import type { MemoryApplyDeal } from './deal-imports'

/** One row of `playbook.calls`, as far as the Transcript path reads or writes it. Times are milliseconds except `created_at_us`. */
export type MemoryCallRow = {
  id: string
  organization_id: string
  deal_record_id: string
  kind: 'transcript' | 'recording'
  file_name: string
  media_type: string
  size_bytes: number
  /** The SHA-256 as lower-case hex. */
  content_hash: string
  uploaded_by: string
  object_key: string
  transcript_key: string | null
  state:
    | 'uploaded'
    | 'transcribing'
    | 'awaiting_rep'
    | 'processing'
    | 'ready'
    | 'failed'
    | 'deleted'
  failure_reason: string | null
  rep_by: 'speaker' | 'channel' | null
  rep_label: string | null
  rep_channel: string | null
  speaker_labels: string[]
  duration_seconds: number | null
  epoch: number
  rep_seq: number
  deletion_seq: number
  deleted_at: number | null
  deleted_by: string | null
  purge_due_at: number | null
  purge_started_at: number | null
  purge_attempts: number
  purge_lease_until: number | null
  restore_barred_at: number | null
  vectors_removed_seq: number | null
  tagged_outcome_seq: number
  sent_to_vendor_at: number | null
  vendor_send_seq: number
  vendor_removed_at: number | null
  created_at_us: number
  updated_at: number
}

/** One row of `playbook.call_jobs`. */
export type MemoryCallJobRow = {
  id: string
  organization_id: string
  call_id: string
  kind: 'transcribe' | 'process' | 'rebuild'
  epoch: number
  rep_seq: number
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  attempts: number
  /** The due time while queued and the end of the lease while running or cancelled mid-run. */
  next_attempt_at: number
  claim_token: string | null
  failure_reason: string | null
}

/** One row of `playbook.call_vendor_sends`: a counted send of a Recording to the vendor and, once recorded, the vendor's id of it. */
export type MemoryVendorSendRow = {
  organization_id: string
  call_id: string
  seq: number
  vendor_id: string | null
}

/** A Deal as the Call statements read and write it; `retag_through` belongs to the re-tag job (PR B). */
export type MemoryCallDeal = MemoryApplyDeal & { retag_through?: number }

/** What the Call statements need from the double they run in. */
export type CallStatementContext = {
  calls: MemoryCallRow[]
  callJobs: MemoryCallJobRow[]
  vendorSends: MemoryVendorSendRow[]
  deals: MemoryCallDeal[]
  rights: { organization_id: string; wording_version: number }[]
  /** Whether the statement runs in `organization`'s scope. */
  own(organization: unknown): boolean
  /** Whether this transaction has taken the Organization's upload lock (`QUOTA_LOCK`). */
  uploadLockHeld(): boolean
  now(): number
  nextMicroseconds(): number
  rows(list: readonly unknown[]): Result
  none: Result
  batch(value: unknown, max: number): number
  pgTimestamp(ms: number): string
  pgTimestampUs(us: number): string
  cursorMicroseconds(text: unknown): number
  postgresError(code: string, message?: string): Error
  /** Whether the Organization has an `organization_usage` row (a Call was ever inserted for it). */
  usageKnown(organization: unknown): boolean
}

const MAX_BATCH = 100

/** Whether a job is still the live one for its Call: the epoch matches and the Call is in a state the job's kind works on. */
function live(job: MemoryCallJobRow, call: MemoryCallRow | undefined): boolean {
  if (call === undefined || call.epoch !== job.epoch) {
    return false
  }
  switch (job.kind) {
    case 'transcribe':
      return call.state === 'uploaded' || call.state === 'transcribing'
    case 'process':
      return call.state === 'uploaded' || call.state === 'processing'
    default:
      return call.state === 'processing' && call.rep_seq === job.rep_seq
  }
}

/** A lease of at least the database's floor. */
const lease = (ms: unknown) => Math.max(typeof ms === 'number' ? ms : 0, PLAYBOOK_MIN_LEASE_MS)

/**
 * Runs one Call statement of the db library against the double, with the rules the README states
 * (v0.16.0, "Sales history, part two"), or returns `undefined` for any other statement. Only a
 * transaction scoped to the statement's Organization sees its rows. Only the statements the
 * Transcript path uses are modelled: the upload, the reads, the job, the purge and the erasure.
 */
export function runCallStatement(
  text: string,
  params: readonly unknown[],
  ctx: CallStatementContext
): Result | undefined {
  const { rows, none, own, now, batch } = ctx
  const mine = (organization: unknown) =>
    ctx.calls.filter((c) => own(organization) && c.organization_id === organization)
  const findCall = (organization: unknown, id: unknown) =>
    mine(organization).find((c) => c.id === id)
  const dealOf = (call: MemoryCallRow) =>
    ctx.deals.find(
      (d) => d.organization_id === call.organization_id && d.id === call.deal_record_id
    )
  const dealsOfOrg = (organization: unknown) =>
    ctx.deals.filter((d) => own(organization) && d.organization_id === organization)
  const jobsOf = (organization: unknown) =>
    ctx.callJobs.filter((j) => own(organization) && j.organization_id === organization)
  const stamp = (ms: number | null) => (ms === null ? null : ctx.pgTimestamp(ms))
  const view = (c: MemoryCallRow) => {
    const d = dealOf(c)
    return {
      id: c.id,
      deal_record_id: c.deal_record_id,
      deal_id: d?.deal_id,
      deal_outcome: d?.outcome,
      in_search:
        c.state === 'ready' &&
        d?.outcome === 'won' &&
        c.tagged_outcome_seq >= (d?.outcome_seq ?? Number.POSITIVE_INFINITY),
      kind: c.kind,
      file_name: c.file_name,
      media_type: c.media_type,
      size_bytes: c.size_bytes,
      duration_seconds: c.duration_seconds,
      state: c.state,
      failure_reason: c.failure_reason,
      rep_by: c.rep_by,
      rep_label: c.rep_label,
      rep_channel: c.rep_channel,
      speaker_labels: [...c.speaker_labels],
      deleted_at: stamp(c.deleted_at),
      purge_due_at: stamp(c.purge_due_at),
      uploaded_by: c.uploaded_by,
      created_at: ctx.pgTimestampUs(c.created_at_us),
      updated_at: ctx.pgTimestamp(c.updated_at),
      rep_seq: c.rep_seq,
      epoch: c.epoch,
      deletion_seq: c.deletion_seq,
      not_restorable:
        c.state === 'deleted' &&
        ((c.purge_due_at ?? Number.POSITIVE_INFINITY) <= now() ||
          c.purge_started_at !== null ||
          c.restore_barred_at !== null),
    }
  }
  const sendsOf = (c: MemoryCallRow) =>
    ctx.vendorSends
      .filter((v) => v.organization_id === c.organization_id && v.call_id === c.id)
      .sort((a, b) => a.seq - b.seq)
      .map((v) => ({ seq: v.seq, vendor_id: v.vendor_id }))
  const touch = (c: MemoryCallRow) => {
    c.updated_at = now()
  }
  const cancelJobs = (organization: unknown, callId: string, keepRunningLease: boolean) => {
    for (const j of jobsOf(organization)) {
      if (j.call_id === callId && (j.state === 'queued' || j.state === 'running')) {
        if (!(keepRunningLease && j.state === 'running')) {
          j.next_attempt_at = now()
        }
        j.state = 'cancelled'
        j.claim_token = null
      }
    }
  }
  const queueJob = (
    call: MemoryCallRow,
    id: string,
    kind: MemoryCallJobRow['kind']
  ): MemoryCallJobRow => {
    const job: MemoryCallJobRow = {
      id,
      organization_id: call.organization_id,
      call_id: call.id,
      kind,
      epoch: call.epoch,
      rep_seq: call.rep_seq,
      state: 'queued',
      attempts: 0,
      next_attempt_at: now(),
      claim_token: null,
      failure_reason: null,
    }
    ctx.callJobs.push(job)
    return job
  }
  const afterKeyset = (c: MemoryCallRow, after: number, idAfter: unknown) => {
    return (
      after === Number.POSITIVE_INFINITY ||
      c.created_at_us < after ||
      (c.created_at_us === after && c.id < String(idAfter))
    )
  }
  const page = (list: MemoryCallRow[], size: unknown) =>
    ctx.rows(
      list
        .sort((a, b) =>
          a.created_at_us === b.created_at_us
            ? a.id < b.id
              ? 1
              : -1
            : b.created_at_us - a.created_at_us
        )
        .slice(0, batch(size, MAX_BATCH))
        .map((c) => ({ ...view(c), cursor_at: ctx.pgTimestampUs(c.created_at_us) }))
    )
  const jobHolds = (c: MemoryCallRow, states: readonly string[]) =>
    ctx.callJobs.some(
      (j) =>
        j.organization_id === c.organization_id &&
        j.call_id === c.id &&
        states.includes(j.state) &&
        j.next_attempt_at > now()
    )

  switch (text) {
    case CALL_INSERT: {
      const [
        organization,
        id,
        dealId,
        newDealRecordId,
        fileName,
        mediaType,
        kind,
        size,
        hash,
        uploadedBy,
        objectKey,
        repBy,
        repLabel,
        repChannel,
        jobId,
        maxCalls,
        maxRecordingBytes,
        maxDeals,
        wordingVersion,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        MemoryCallRow['kind'],
        number,
        Uint8Array | Buffer,
        string,
        string,
        MemoryCallRow['rep_by'],
        string | null,
        string | null,
        string,
        number,
        number,
        number,
        number,
      ]
      if (!own(organization)) {
        return none
      }
      const contentHash = Buffer.from(hash).toString('hex')
      const rightsOk = ctx.rights.some(
        (r) => r.organization_id === organization && r.wording_version === wordingVersion
      )
      const dup = mine(organization).find(
        (c) =>
          c.content_hash === contentHash &&
          c.purge_started_at === null &&
          c.restore_barred_at === null
      )
      const deal = ctx.deals.find((d) => d.organization_id === organization && d.deal_id === dealId)
      if (!rightsOk) {
        return rows([{ result: 'rights_required', id: null, state: null, failure_reason: null }])
      }
      if (dup !== undefined) {
        const same = dealOf(dup)?.deal_id === dealId
        return rows([
          {
            result: same ? 'existing' : 'other_deal',
            id: same ? dup.id : null,
            state: same ? dup.state : null,
            failure_reason: same ? dup.failure_reason : null,
          },
        ])
      }
      const callCount = mine(organization).length
      const recordingBytes = mine(organization)
        .filter((c) => c.kind === 'recording')
        .reduce((sum, c) => sum + c.size_bytes, 0)
      const dealCount = ctx.deals.filter((d) => d.organization_id === organization).length
      const quotaOk =
        callCount < maxCalls &&
        (kind !== 'recording' || recordingBytes + size <= maxRecordingBytes) &&
        (deal !== undefined || dealCount < maxDeals)
      if (!quotaOk) {
        return rows([{ result: 'quota_exceeded', id: null, state: null, failure_reason: null }])
      }
      if (!ctx.uploadLockHeld()) {
        // What `playbook.require_upload_lock` raises for a Call or Deal row about to be written.
        throw ctx.postgresError(
          '55000',
          'playbook.upload_lock: the Organization upload lock is not held'
        )
      }
      let dealRecordId = deal?.id
      if (deal === undefined) {
        ctx.deals.push({
          id: newDealRecordId,
          organization_id: organization,
          deal_id: dealId,
          name: null,
          outcome: 'open',
          outcome_seq: 0,
          closed_at: null,
          amount: null,
          currency: null,
          appeared_in_import: false,
          created_at_us: ctx.nextMicroseconds(),
          updated_at: now(),
        })
        dealRecordId = newDealRecordId
      }
      const call: MemoryCallRow = {
        id,
        organization_id: organization,
        deal_record_id: String(dealRecordId),
        kind,
        file_name: fileName,
        media_type: mediaType,
        size_bytes: size,
        content_hash: contentHash,
        uploaded_by: uploadedBy,
        object_key: objectKey,
        transcript_key: null,
        state: 'uploaded',
        failure_reason: null,
        rep_by: repBy,
        rep_label: repLabel,
        rep_channel: repChannel,
        speaker_labels: [],
        duration_seconds: null,
        epoch: 0,
        rep_seq: 0,
        deletion_seq: 0,
        deleted_at: null,
        deleted_by: null,
        purge_due_at: null,
        purge_started_at: null,
        purge_attempts: 0,
        purge_lease_until: null,
        restore_barred_at: null,
        vectors_removed_seq: null,
        tagged_outcome_seq: 0,
        sent_to_vendor_at: null,
        vendor_send_seq: 0,
        vendor_removed_at: null,
        created_at_us: ctx.nextMicroseconds(),
        updated_at: now(),
      }
      ctx.calls.push(call)
      queueJob(call, jobId, kind === 'recording' ? 'transcribe' : 'process')
      return rows([{ result: 'created', id, state: 'uploaded', failure_reason: null }])
    }
    case CALL_SENT_TO_VENDOR: {
      const [organization, jobId, token] = params as [string, string, string]
      const j = jobsOf(organization).find(
        (x) => x.id === jobId && x.claim_token === token && x.state === 'running'
      )
      const c = j === undefined ? undefined : findCall(organization, j.call_id)
      if (j === undefined || c === undefined || !live(j, c)) {
        return none
      }
      if (c.vendor_send_seq >= CALL_MAX_VENDOR_SENDS) {
        return rows([{ id: c.id, vendor_send_seq: c.vendor_send_seq, sent: false }])
      }
      c.vendor_send_seq += 1
      c.sent_to_vendor_at = now()
      c.vendor_removed_at = null
      touch(c)
      ctx.vendorSends.push({
        organization_id: organization,
        call_id: c.id,
        seq: c.vendor_send_seq,
        vendor_id: null,
      })
      return rows([{ id: c.id, vendor_send_seq: c.vendor_send_seq, sent: true }])
    }
    case CALL_VENDOR_ID_RECORD: {
      const [organization, callId, seq, vendorId] = params as [string, string, number, string]
      const current = ctx.vendorSends.find(
        (v) =>
          own(organization) &&
          v.organization_id === organization &&
          v.call_id === callId &&
          v.seq === seq
      )
      if (current === undefined) {
        return none
      }
      if (typeof vendorId !== 'string' || !new RegExp(CALL_VENDOR_ID_PATTERN).test(vendorId)) {
        return rows([{ result: 'invalid' }])
      }
      const taken = ctx.vendorSends.some(
        (v) =>
          v.organization_id === organization &&
          v.vendor_id === vendorId &&
          !(v.call_id === callId && v.seq === seq)
      )
      if (current.vendor_id === null && !taken) {
        current.vendor_id = vendorId
        return rows([{ result: 'recorded' }])
      }
      return rows([{ result: current.vendor_id === vendorId ? 'unchanged' : 'conflict' }])
    }
    case CALL_VENDOR_REMOVED: {
      const [organization, id, seq] = params as [string, string, number]
      const c = findCall(organization, id)
      if (
        c === undefined ||
        c.state !== 'deleted' ||
        c.vendor_send_seq !== seq ||
        c.sent_to_vendor_at === null ||
        jobHolds(c, ['cancelled', 'running'])
      ) {
        return none
      }
      c.vendor_removed_at ??= now()
      touch(c)
      return rows([{ id: c.id }])
    }
    case CALL_JOB_TRANSCRIBED: {
      const [organization, id, token, processJobId] = params as [string, string, string, string]
      const j = jobsOf(organization).find(
        (x) =>
          x.id === id && x.claim_token === token && x.state === 'running' && x.kind === 'transcribe'
      )
      const c = j === undefined ? undefined : findCall(organization, j.call_id)
      if (
        j === undefined ||
        c === undefined ||
        c.state !== 'transcribing' ||
        c.epoch !== j.epoch ||
        c.transcript_key === null
      ) {
        return none
      }
      j.state = 'succeeded'
      j.claim_token = null
      c.state = c.rep_by === null ? 'awaiting_rep' : 'processing'
      touch(c)
      if (c.state === 'processing') {
        queueJob(c, processJobId, 'process')
      }
      return rows([{ id: c.id, state: c.state }])
    }
    case CALL_GET: {
      const [organization, id] = params as [string, string]
      const c = findCall(organization, id)
      return c === undefined ? none : rows([view(c)])
    }
    case CALL_LIST:
    case CALL_LIST_BY_STATE:
    case CALL_LIST_BY_DEAL:
    case CALL_LIST_BY_DEAL_STATE: {
      const [organization, createdAfter, idAfter, size, first, second] = params as [
        string,
        string,
        string,
        number | null,
        string | undefined,
        string | undefined,
      ]
      // Parsed first, as the statement casts it whether or not a row follows.
      const after = ctx.cursorMicroseconds(createdAfter)
      const wanted = mine(organization).filter((c) => {
        if (text === CALL_LIST) {
          return c.state !== 'deleted'
        }
        if (text === CALL_LIST_BY_STATE) {
          return c.state === first
        }
        if (text === CALL_LIST_BY_DEAL) {
          return c.deal_record_id === first && c.state !== 'deleted'
        }
        return c.state === second && c.deal_record_id === first
      })
      return page(
        wanted.filter((c) => afterKeyset(c, after, idAfter)),
        size
      )
    }
    case CALL_REQUEUE:
    case CALL_RESTORE_FOR_UPLOAD: {
      const [organization, id, jobId] = params as [string, string, string]
      const c = findCall(organization, id)
      if (c === undefined) {
        return none
      }
      if (text === CALL_REQUEUE) {
        const transient = ['transcription_failed', 'transcription_timed_out', 'processing_failed']
        if (
          c.state === 'failed' &&
          transient.includes(String(c.failure_reason)) &&
          c.vendor_send_seq < CALL_MAX_VENDOR_SENDS
        ) {
          cancelJobs(organization, c.id, false)
          c.state = 'uploaded'
          c.failure_reason = null
          c.epoch += 1
          touch(c)
          queueJob(
            c,
            jobId,
            c.kind === 'recording' && c.transcript_key === null ? 'transcribe' : 'process'
          )
          return rows([{ id: c.id, state: 'uploaded', epoch: c.epoch, changed: true }])
        }
        return c.state === 'deleted'
          ? none
          : rows([{ id: c.id, state: c.state, epoch: c.epoch, changed: false }])
      }
      if (c.state === 'deleted' && c.purge_started_at === null && c.restore_barred_at === null) {
        cancelJobs(organization, c.id, false)
        c.state =
          c.kind === 'recording' && c.transcript_key === null
            ? 'uploaded'
            : c.rep_by === null
              ? 'awaiting_rep'
              : 'processing'
        c.epoch += 1
        c.deleted_at = c.deleted_by = c.purge_due_at = null
        touch(c)
        if (c.state !== 'awaiting_rep') {
          queueJob(c, jobId, c.state === 'uploaded' ? 'transcribe' : 'process')
        }
        return rows([
          { id: c.id, state: c.state, epoch: c.epoch, deletion_seq: c.deletion_seq, changed: true },
        ])
      }
      return c.state === 'deleted'
        ? none
        : rows([
            {
              id: c.id,
              state: c.state,
              epoch: c.epoch,
              deletion_seq: c.deletion_seq,
              changed: false,
            },
          ])
    }
    case CALL_JOB_CLAIM: {
      const [organization, size, leaseMs, onlyId] = params as [
        string,
        number,
        number,
        string | null,
      ]
      const due = jobsOf(organization)
        .filter(
          (j) =>
            (j.state === 'queued' || j.state === 'running') &&
            j.attempts < CALL_JOB_MAX_ATTEMPTS &&
            j.next_attempt_at <= now() &&
            (onlyId === null || onlyId === undefined || j.id === onlyId)
        )
        .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
        .slice(0, batch(size, MAX_BATCH))
      let cancelled = 0
      const out: Record<string, unknown>[] = []
      let claimed = 0
      for (const j of due) {
        const c = findCall(organization, j.call_id)
        if (!live(j, c) || c === undefined) {
          j.state = 'cancelled'
          j.claim_token = null
          cancelled++
          continue
        }
        claimed++
        j.state = 'running'
        j.attempts += 1
        j.claim_token = crypto.randomUUID()
        j.next_attempt_at = now() + lease(leaseMs)
        if (j.kind === 'transcribe') {
          c.state = 'transcribing'
        } else if (j.kind === 'process') {
          c.state = 'processing'
        }
        touch(c)
        out.push({
          id: j.id,
          call_id: j.call_id,
          job_kind: j.kind,
          epoch: j.epoch,
          rep_seq: j.rep_seq,
          attempts: j.attempts,
          claim_token: j.claim_token,
          call_kind: c.kind,
          media_type: c.media_type,
          size_bytes: c.size_bytes,
          object_key: c.object_key,
          transcript_key: c.transcript_key,
          rep_by: c.rep_by,
          rep_label: c.rep_label,
          rep_channel: c.rep_channel,
          speaker_labels: [...c.speaker_labels],
          sent_to_vendor_at: stamp(c.sent_to_vendor_at),
        })
      }
      if (out.length === 0 && (cancelled > 0 || claimed > 0)) {
        return rows([
          {
            id: null,
            call_id: null,
            job_kind: null,
            epoch: null,
            rep_seq: null,
            attempts: null,
            claim_token: null,
            call_kind: null,
            media_type: null,
            size_bytes: null,
            object_key: null,
            transcript_key: null,
            rep_by: null,
            rep_label: null,
            rep_channel: null,
            speaker_labels: null,
            sent_to_vendor_at: null,
            cancelled,
            lost: 0,
          },
        ])
      }
      return rows(out.map((row) => ({ ...row, cancelled, lost: 0 })))
    }
    case CALL_JOB_HEARTBEAT: {
      const [organization, id, token, leaseMs] = params as [string, string, string, number]
      const j = jobsOf(organization).find(
        (x) => x.id === id && x.claim_token === token && x.state === 'running'
      )
      if (j === undefined || !live(j, findCall(organization, j.call_id))) {
        return none
      }
      j.next_attempt_at = now() + lease(leaseMs)
      return rows([{ id: j.id }])
    }
    case CALL_JOB_RETRY: {
      const [organization, id, token, delayMs] = params as [string, string, string, number]
      const j = jobsOf(organization).find(
        (x) => x.id === id && x.claim_token === token && x.state === 'running'
      )
      if (j === undefined) {
        return none
      }
      j.state = 'queued'
      j.claim_token = null
      j.next_attempt_at = now() + Math.min(Math.max(delayMs ?? 0, 0), INGESTION_MAX_RETRY_DELAY_MS)
      return rows([{ id: j.id, attempts: j.attempts }])
    }
    case CALL_JOB_RECORD: {
      const [organization, id, token, transcriptKey, duration, labels, leaseMs] = params as [
        string,
        string,
        string,
        string | null,
        number | null,
        string | null,
        number,
      ]
      // The statement helper binds a JavaScript array as a list `($1, $2)`, which Postgres cannot cast to text[].
      if (labels !== null && labels !== undefined && typeof labels !== 'string') {
        throw ctx.postgresError('42846', 'cannot cast type record to text[]')
      }
      const parsedLabels =
        labels === null || labels === undefined ? null : parseTextArrayLiteral(labels)
      if (labels !== null && labels !== undefined && parsedLabels === undefined) {
        throw ctx.postgresError('22P02', 'malformed array literal')
      }
      const j = jobsOf(organization).find(
        (x) => x.id === id && x.claim_token === token && x.state === 'running'
      )
      const c = j === undefined ? undefined : findCall(organization, j.call_id)
      if (j === undefined || c === undefined || !live(j, c)) {
        return none
      }
      j.next_attempt_at = now() + lease(leaseMs)
      c.transcript_key = transcriptKey ?? c.transcript_key
      c.duration_seconds = duration ?? c.duration_seconds
      c.speaker_labels = parsedLabels ?? c.speaker_labels
      touch(c)
      return rows([{ id: c.id }])
    }
    case CALL_JOB_COMPLETE: {
      const [organization, id, token, outcomeSeq] = params as [string, string, string, number]
      const j = jobsOf(organization).find(
        (x) => x.id === id && x.claim_token === token && x.state === 'running'
      )
      const c = j === undefined ? undefined : findCall(organization, j.call_id)
      const deal = c === undefined ? undefined : dealOf(c)
      if (
        j === undefined ||
        c === undefined ||
        deal === undefined ||
        (j.kind !== 'process' && j.kind !== 'rebuild') ||
        c.state !== 'processing' ||
        c.epoch !== j.epoch ||
        (j.kind === 'rebuild' && c.rep_seq !== j.rep_seq) ||
        c.rep_by === null ||
        (c.rep_by === 'speaker' && !c.speaker_labels.includes(String(c.rep_label)))
      ) {
        return none
      }
      j.state = 'succeeded'
      j.claim_token = null
      c.state = 'ready'
      c.tagged_outcome_seq = Math.max(c.tagged_outcome_seq, Math.min(outcomeSeq, deal.outcome_seq))
      touch(c)
      if (c.tagged_outcome_seq < deal.outcome_seq) {
        deal.retag_through = Math.min(deal.retag_through ?? 0, c.tagged_outcome_seq)
      }
      return rows([{ id: c.id }])
    }
    case CALL_JOB_FAIL: {
      const [organization, id, token, reason] = params as [string, string, string, string]
      const j = jobsOf(organization).find(
        (x) => x.id === id && x.claim_token === token && x.state === 'running'
      )
      const c = j === undefined ? undefined : findCall(organization, j.call_id)
      if (j === undefined || c === undefined || !live(j, c)) {
        return none
      }
      j.state = 'failed'
      j.failure_reason = reason
      j.claim_token = null
      if (['uploaded', 'transcribing', 'processing'].includes(c.state)) {
        c.state = 'failed'
        c.failure_reason = reason
        if (reason === 'too_many_speakers') {
          c.speaker_labels = []
        }
        touch(c)
        return rows([{ id: c.id }])
      }
      return none
    }
    case CALL_JOB_GIVE_UP_SPENT: {
      const [organization, size] = params as [string, number]
      const spent = jobsOf(organization)
        .filter(
          (j) =>
            (j.state === 'queued' || j.state === 'running') &&
            j.attempts >= CALL_JOB_MAX_ATTEMPTS &&
            j.next_attempt_at <= now()
        )
        .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
        .slice(0, batch(size, MAX_BATCH))
      return rows(
        spent.map((j) => {
          j.state = 'failed'
          j.failure_reason = 'processing_failed'
          j.claim_token = null
          const c = findCall(organization, j.call_id)
          if (
            c !== undefined &&
            c.epoch === j.epoch &&
            ['uploaded', 'transcribing', 'processing'].includes(c.state)
          ) {
            c.state = 'failed'
            c.failure_reason = 'processing_failed'
            touch(c)
          }
          return { call_id: j.call_id }
        })
      )
    }
    case CALL_CLEANUP_BEGIN: {
      const [organization, id, seq] = params as [string, string, number]
      const c = findCall(organization, id)
      if (c === undefined || c.state !== 'deleted' || c.deletion_seq !== seq) {
        return none
      }
      return rows([{ id: c.id, epoch: c.epoch, clear: !jobHolds(c, ['cancelled', 'running']) }])
    }
    case CALL_LIST_PENDING_CLEANUP: {
      const [organization, at, afterId, size] = params as [string, string, string, number]
      const after = at === '-infinity' ? Number.NEGATIVE_INFINITY : ctx.cursorMicroseconds(at)
      const pending = mine(organization)
        .filter(
          (c) =>
            c.state === 'deleted' &&
            (c.vectors_removed_seq === null || c.vectors_removed_seq < c.deletion_seq)
        )
        .filter((c) => {
          const deleted = (c.deleted_at ?? 0) * 1000
          return deleted > after || (deleted === after && c.id > afterId)
        })
        .sort((a, b) =>
          a.deleted_at === b.deleted_at
            ? a.id < b.id
              ? -1
              : 1
            : (a.deleted_at ?? 0) - (b.deleted_at ?? 0)
        )
        .slice(0, batch(size, MAX_BATCH))
      return rows(
        pending.map((c) => ({
          id: c.id,
          epoch: c.epoch,
          deletion_seq: c.deletion_seq,
          deleted_at: stamp(c.deleted_at),
          cursor_at: stamp(c.deleted_at),
        }))
      )
    }
    case CALL_CLEANUP_DONE: {
      const [organization, id, seq] = params as [string, string, number]
      const c = findCall(organization, id)
      if (c === undefined || c.state !== 'deleted' || c.deletion_seq !== seq) {
        return none
      }
      c.vectors_removed_seq = seq
      touch(c)
      return rows([{ id: c.id }])
    }
    case CALL_PURGE_CLAIM: {
      const [organization, size, leaseMs] = params as [string, number, number]
      const due = mine(organization)
        .filter(
          (c) =>
            c.state === 'deleted' &&
            (c.purge_due_at ?? Number.POSITIVE_INFINITY) <= now() &&
            c.purge_attempts < CALL_PURGE_MAX_ATTEMPTS &&
            (c.purge_lease_until === null || c.purge_lease_until <= now()) &&
            !jobHolds(c, ['running', 'cancelled'])
        )
        .sort((a, b) => (a.purge_due_at ?? 0) - (b.purge_due_at ?? 0))
        .slice(0, batch(size, MAX_BATCH))
      return rows(
        due.map((c) => {
          c.purge_started_at ??= now()
          c.purge_attempts += 1
          c.purge_lease_until = now() + lease(leaseMs)
          touch(c)
          return {
            id: c.id,
            kind: c.kind,
            object_key: c.object_key,
            transcript_key: c.transcript_key,
            size_bytes: c.size_bytes,
            deletion_seq: c.deletion_seq,
            vectors_removed_seq: c.vectors_removed_seq,
            sent_to_vendor_at: stamp(c.sent_to_vendor_at),
            vendor_send_seq: c.vendor_send_seq,
            vendor_removed_at: stamp(c.vendor_removed_at),
            purge_attempts: c.purge_attempts,
            vendor_sends: sendsOf(c),
          }
        })
      )
    }
    case CALL_PURGE_COMPLETE: {
      const [organization, id] = params as [string, string]
      const c = findCall(organization, id)
      if (
        c === undefined ||
        c.state !== 'deleted' ||
        c.purge_started_at === null ||
        c.vectors_removed_seq !== c.deletion_seq ||
        (c.sent_to_vendor_at !== null && c.vendor_removed_at === null) ||
        jobHolds(c, ['running', 'cancelled'])
      ) {
        return none
      }
      ctx.calls.splice(ctx.calls.indexOf(c), 1)
      // The vendor sends go with it (the foreign key cascades), like its jobs.
      for (const v of ctx.vendorSends.filter(
        (x) => x.call_id === c.id && x.organization_id === organization
      )) {
        ctx.vendorSends.splice(ctx.vendorSends.indexOf(v), 1)
      }
      // The jobs of a Call go with it (the foreign key cascades).
      for (const j of ctx.callJobs.filter(
        (x) => x.call_id === c.id && x.organization_id === organization
      )) {
        ctx.callJobs.splice(ctx.callJobs.indexOf(j), 1)
      }
      return rows([{ id: c.id, size_bytes: c.size_bytes }])
    }
    case CALL_LIST_SPENT_PURGES: {
      const [organization, afterId, size] = params as [string, string, number]
      return rows(
        mine(organization)
          .filter(
            (c) =>
              c.state === 'deleted' && c.purge_attempts >= CALL_PURGE_MAX_ATTEMPTS && c.id > afterId
          )
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, batch(size, MAX_BATCH))
          .map((c) => ({
            id: c.id,
            kind: c.kind,
            object_key: c.object_key,
            transcript_key: c.transcript_key,
            deletion_seq: c.deletion_seq,
            vectors_removed_seq: c.vectors_removed_seq,
            purge_attempts: c.purge_attempts,
            vendor_sends: sendsOf(c),
          }))
      )
    }
    case CALL_ERASE_BATCH: {
      const [organization, size, deletedBy] = params as [string, number, string]
      const candidates = mine(organization)
        .filter((c) => c.restore_barred_at === null)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, batch(size, MAX_BATCH))
      const at = now()
      return rows(
        candidates.map((c) => {
          cancelJobs(organization, c.id, true)
          const changed = c.state !== 'deleted'
          if (changed) {
            c.epoch += 1
            c.deletion_seq += 1
            c.deleted_at = at
            c.deleted_by = deletedBy
          }
          c.state = 'deleted'
          c.purge_due_at = Math.min(c.purge_due_at ?? at, at)
          c.restore_barred_at = at
          c.failure_reason = null
          touch(c)
          return {
            id: c.id,
            epoch: c.epoch,
            deletion_seq: c.deletion_seq,
            changed,
            object_key: c.object_key,
            transcript_key: c.transcript_key,
            kind: c.kind,
            sent_to_vendor_at: stamp(c.sent_to_vendor_at),
            vendor_send_seq: c.vendor_send_seq,
            vendor_sends: sendsOf(c),
          }
        })
      )
    }
    case CALL_USAGE: {
      const [organization] = params as [string]
      const list = mine(organization)
      if (list.length === 0 && !ctx.usageKnown(organization)) {
        return none
      }
      return rows([
        {
          call_count: list.length,
          recording_byte_count: list
            .filter((c) => c.kind === 'recording')
            .reduce((sum, c) => sum + c.size_bytes, 0),
        },
      ])
    }
    case DEAL_LIST_PENDING_RETAG: {
      const [organization, after, size] = params as [string, string, number]
      const limit = Math.min(Math.max(Number(size) || 1, 1), 500)
      return rows(
        dealsOfOrg(organization)
          .filter((d) => (d.retag_through ?? 0) < d.outcome_seq && d.id > after)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit)
          .map((d) => ({
            id: d.id,
            outcome: d.outcome,
            outcome_seq: d.outcome_seq,
            retag_through: d.retag_through ?? 0,
          }))
      )
    }
    case DEAL_RETAG_BATCH: {
      const [organization, dealRecordId, after, size] = params as [string, string, string, number]
      const limit = Math.min(Math.max(Number(size) || 1, 1), 500)
      const deal = dealsOfOrg(organization).find((d) => d.id === dealRecordId)
      if (deal === undefined) {
        return none
      }
      return rows(
        mine(organization)
          .filter(
            (c) =>
              c.deal_record_id === dealRecordId &&
              c.state === 'ready' &&
              c.tagged_outcome_seq < deal.outcome_seq &&
              c.id > after
          )
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit)
          .map((c) => ({ id: c.id, outcome: deal.outcome, outcome_seq: deal.outcome_seq }))
      )
    }
    case CALL_RETAGGED: {
      const [organization, ids, seq] = params as [string, string, number]
      // As for CALL_JOB_RECORD: a JavaScript array is bound as a list and Postgres cannot cast it.
      if (typeof ids !== 'string') {
        throw ctx.postgresError('42846', 'cannot cast type record to text[]')
      }
      const wanted = parseTextArrayLiteral(ids)
      if (wanted === undefined) {
        throw ctx.postgresError('22P02', 'malformed array literal')
      }
      const updated: { id: string }[] = []
      for (const id of wanted.slice(0, 500)) {
        const c = findCall(organization, id)
        const d = c === undefined ? undefined : dealOf(c)
        if (
          c !== undefined &&
          d !== undefined &&
          c.state === 'ready' &&
          c.tagged_outcome_seq < seq &&
          seq <= d.outcome_seq
        ) {
          c.tagged_outcome_seq = seq
          touch(c)
          updated.push({ id: c.id })
        }
      }
      return rows(updated)
    }
    case DEAL_RETAG_LOCK: {
      const [organization, id] = params as [string, string]
      const d = dealsOfOrg(organization).find((x) => x.id === id)
      return d === undefined
        ? none
        : rows([
            {
              id: d.id,
              outcome: d.outcome,
              outcome_seq: d.outcome_seq,
              retag_through: d.retag_through ?? 0,
            },
          ])
    }
    case DEAL_RETAG_DONE: {
      const [organization, id, seq] = params as [string, string, number]
      const d = dealsOfOrg(organization).find((x) => x.id === id)
      if (
        d === undefined ||
        (d.retag_through ?? 0) >= seq ||
        seq > d.outcome_seq ||
        mine(organization).some(
          (c) => c.deal_record_id === id && c.state === 'ready' && c.tagged_outcome_seq < seq
        )
      ) {
        return none
      }
      d.retag_through = seq
      return rows([{ id: d.id, retag_through: seq, outcome_seq: d.outcome_seq }])
    }
    case CALL_SET_REP: {
      const [organization, id, by, label, channel, jobId] = params as [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
      ]
      const c = findCall(organization, id)
      if (c === undefined) {
        return none
      }
      const same =
        c.rep_by === by &&
        c.rep_label === (by === 'speaker' ? label : null) &&
        c.rep_channel === (by === 'channel' ? channel : null)
      let result: 'invalid' | 'unchanged' | 'not_changeable' | 'changed'
      if (by === null || (by !== 'speaker' && by !== 'channel')) {
        result = 'invalid'
      } else if (c.state !== 'deleted' && same && c.state !== 'failed') {
        result = 'unchanged'
      } else if (
        !(
          c.state === 'ready' ||
          c.state === 'awaiting_rep' ||
          (c.state === 'failed' &&
            (c.failure_reason === 'rep_label_not_found' || c.failure_reason === 'not_per_side'))
        )
      ) {
        result = 'not_changeable'
      } else if (
        !(
          (by === 'speaker' && label !== null && c.speaker_labels.includes(label)) ||
          (by === 'channel' &&
            c.kind === 'recording' &&
            (channel === 'left' || channel === 'right'))
        )
      ) {
        result = 'invalid'
      } else {
        result = 'changed'
      }
      if (result !== 'changed') {
        return rows([{ result, id: c.id, state: c.state, rep_seq: c.rep_seq }])
      }
      // The job keeps its lease when it was running: it may still have a request in flight.
      cancelJobs(organization, c.id, true)
      c.rep_by = by as 'speaker' | 'channel'
      c.rep_label = by === 'speaker' ? label : null
      c.rep_channel = by === 'channel' ? channel : null
      c.rep_seq += 1
      c.state = 'processing'
      c.failure_reason = null
      touch(c)
      queueJob(c, jobId, 'rebuild')
      return rows([{ result: 'changed', id: c.id, state: 'processing', rep_seq: c.rep_seq }])
    }
    case CALL_SOFT_DELETE: {
      const [organization, id, user, retentionMs] = params as [string, string, string, number]
      const c = findCall(organization, id)
      if (c === undefined) {
        return none
      }
      if (c.state === 'deleted') {
        return rows([
          {
            id: c.id,
            state: c.state,
            deletion_seq: c.deletion_seq,
            purge_due_at: stamp(c.purge_due_at),
            changed: false,
          },
        ])
      }
      cancelJobs(organization, c.id, true)
      c.state = 'deleted'
      c.epoch += 1
      c.deletion_seq += 1
      c.deleted_at = now()
      c.deleted_by = user
      c.purge_due_at = now() + Math.max(Number(retentionMs) || 0, 3_600_000)
      c.failure_reason = null
      touch(c)
      return rows([
        {
          id: c.id,
          state: c.state,
          deletion_seq: c.deletion_seq,
          purge_due_at: stamp(c.purge_due_at),
          changed: true,
        },
      ])
    }
    case CALL_RESTORE: {
      const [organization, id, jobId] = params as [string, string, string]
      const c = findCall(organization, id)
      if (c === undefined) {
        return none
      }
      if (c.state !== 'deleted') {
        return rows([
          {
            id: c.id,
            state: c.state,
            epoch: c.epoch,
            deletion_seq: c.deletion_seq,
            changed: false,
          },
        ])
      }
      if (
        c.purge_started_at !== null ||
        c.restore_barred_at !== null ||
        (c.purge_due_at ?? Number.NEGATIVE_INFINITY) <= now()
      ) {
        return none
      }
      cancelJobs(organization, c.id, false)
      c.state =
        c.kind === 'recording' && c.transcript_key === null
          ? 'uploaded'
          : c.rep_by === null
            ? 'awaiting_rep'
            : 'processing'
      c.epoch += 1
      c.deleted_at = null
      c.deleted_by = null
      c.purge_due_at = null
      touch(c)
      if (c.state !== 'awaiting_rep') {
        queueJob(c, jobId, c.state === 'uploaded' ? 'transcribe' : 'process')
      }
      return rows([
        { id: c.id, state: c.state, epoch: c.epoch, deletion_seq: c.deletion_seq, changed: true },
      ])
    }
    default:
      return undefined
  }
}
