import {
  type Call,
  type CallCursor,
  CURRENT_RIGHTS_WORDING_VERSION,
  callCursorSchema,
  callReuploadRequeues,
  callSchema,
  checkCallFile,
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_RECORDING_BYTES_TOTAL,
  DOCUMENT_RETENTION_DAYS,
  decodeCursor,
  encodeCursor,
  formatId,
  type ListCallsQuery,
  type ListCallsResponse,
  MEDIA_TYPE_BY_CALL_EXTENSION,
  PLAYBOOK_WRITE_ROLES,
  parseRepField,
  type RepChoice,
  repChoiceSuits,
  SALES_HISTORY_READ_ROLES,
  type SetCallRepRequest,
  uploadCallFieldsSchema,
} from 'tula-closeline-contract'
import {
  CALL_GET,
  CALL_INSERT,
  CALL_LIST,
  CALL_LIST_BY_DEAL,
  CALL_LIST_BY_DEAL_STATE,
  CALL_LIST_BY_STATE,
  CALL_REQUEUE,
  CALL_RESTORE,
  CALL_RESTORE_FOR_UPLOAD,
  CALL_SET_REP,
  CALL_SOFT_DELETE,
  QUOTA_LOCK,
} from 'tula-closeline-db'
import { AppError } from 'tula-closeline-kit'
import type { Run } from '~/adapters/postgres/processed-store'
import type { Container } from '~/container'
import { registry } from '~/messages'
import { settleObject } from '~/modules/deal-import/service'
import {
  completeKey,
  type KeyedRequest,
  LOCK_TIMEOUT_SQL,
  requestHashOf,
  reserveKey,
} from '~/modules/document/idempotency'
import {
  asStorageFailure,
  ObjectRequired,
  recordUploadAttempt,
  rolledBack,
  sha256,
} from '~/modules/document/service'
import {
  assertRole,
  type CallContext,
  failure,
  mappingBadCursor,
  transaction,
} from '~/modules/service-kit'
import { callObjectKey } from './keys'
import { callCursorOf, toCall } from './schema'
import type { TranscriptMediaType } from './transcript'

/** What the Call service needs from the container. */
export type CallDeps = Pick<Container, 'scope' | 'objects' | 'logger' | 'env' | 'queue'>

/** The route name a Call upload's idempotency key is stored under. */
export const CALL_UPLOAD_IDEMPOTENCY_ROUTE = 'calls.upload'

/** A Call upload after its checks: the kind, the stored extension and media type, and the Rep. */
export type CheckedCallUpload = {
  extension: '.txt' | '.vtt' | '.srt' | '.json'
  mediaType: TranscriptMediaType
  rep: Extract<RepChoice, { by: 'speaker' }>
  dealId: string
}

/** The extension of a file name, lower case, as the contract judges it. */
function extensionOf(fileName: string): string {
  const dot = fileName.toLowerCase().lastIndexOf('.')
  return dot < 0 ? '' : fileName.toLowerCase().slice(dot)
}

/**
 * Checks everything about an upload that does not need the bytes beyond their size: the file part
 * (size, then type, by the contract's `checkCallFile`), the text fields and the Rep. A Recording is
 * `call.unsupported_type` for now (Recordings are a later ticket); a Rep that does not suit a
 * Transcript is `call.rep_invalid`. The refusal never carries the name, the deal id or the label.
 */
export function checkCallUpload(
  file: { fileName: string; declaredMediaType: string | null; sizeBytes: number },
  fields: { dealId: string | undefined; rep: string | undefined }
): CheckedCallUpload {
  const checked = checkCallFile(file)
  if (!checked.ok) {
    throw failure(checked.code)
  }
  if (checked.kind !== 'transcript') {
    throw failure('call.unsupported_type')
  }
  const parsedFields = uploadCallFieldsSchema.safeParse({
    dealId: fields.dealId,
    ...(fields.rep === undefined ? {} : { rep: fields.rep }),
  })
  if (!parsedFields.success) {
    throw failure('request.invalid')
  }
  const rep = parseRepField(parsedFields.data.rep)
  if (!rep.ok || !repChoiceSuits('transcript', rep.rep, 'upload') || rep.rep?.by !== 'speaker') {
    throw failure('call.rep_invalid')
  }
  const extension = extensionOf(checked.file.fileName)
  const mediaType =
    MEDIA_TYPE_BY_CALL_EXTENSION[extension as keyof typeof MEDIA_TYPE_BY_CALL_EXTENSION]
  if (
    extension !== '.txt' &&
    extension !== '.vtt' &&
    extension !== '.srt' &&
    extension !== '.json'
  ) {
    throw failure('call.unsupported_type')
  }
  return {
    extension,
    mediaType: mediaType as TranscriptMediaType,
    rep: rep.rep,
    dealId: parsedFields.data.dealId,
  }
}

/**
 * Confirms the content is the kind of file the extension says, as far as is cheap: valid UTF-8
 * without a NUL, WebVTT starting with its header, JSON starting with `[` or `{`. An empty file is
 * `request.invalid`; anything else wrong is `call.unsupported_type`. The text is not read as
 * instructions and appears in no error.
 */
export function assertTranscriptContent(bytes: Uint8Array, mediaType: TranscriptMediaType): void {
  if (bytes.byteLength === 0) {
    throw failure('request.invalid')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw failure('call.unsupported_type')
  }
  if (text.includes('\u0000')) {
    throw failure('call.unsupported_type')
  }
  const head = text.replace(/^﻿/, '').trimStart()
  if (mediaType === 'text/vtt' && !head.startsWith('WEBVTT')) {
    throw failure('call.unsupported_type')
  }
  if (mediaType === 'application/json' && !head.startsWith('[') && !head.startsWith('{')) {
    throw failure('call.unsupported_type')
  }
}

/** What a caller hands the upload: the file's bytes (the limit is already enforced), the text fields and an optional key. */
export type CallUploadInput = {
  fileName: string
  declaredMediaType: string | null
  bytes: Uint8Array
  dealId: string | undefined
  rep: string | undefined
  idempotencyKey: string | undefined
}

/** What an upload answers. */
export type CallUploadResult = { status: 200 | 201; call: Call }

/** What the upload transaction decided. */
type UploadOutcome =
  | { kind: 'replay'; status: number; response: unknown }
  | { kind: 'done'; status: 200 | 201; call: Call; created: boolean }

/** The refusal for a missing rights confirmation: the contract's code with the wording version the portal must show. */
function rightsRequired(): AppError {
  const refusal = failure('rights.confirmation_required')
  return new AppError({
    code: refusal.code,
    status: refusal.status,
    message: refusal.message,
    details: { wordingVersion: CURRENT_RIGHTS_WORDING_VERSION },
  })
}

/**
 * Stores one Transcript and queues its processing. Owner and Admin only. The order, and why:
 *
 * 1. Check the file, the fields, the Rep and the content. Nothing is stored yet.
 * 2. One transaction: claim the idempotency key, then the Organization's upload lock, then
 *    `CALL_INSERT`, which checks the rights confirmation at the current wording version, the
 *    duplicate rule and the quota in one statement. When the insert is the next step and the file is
 *    not stored, the transaction rolls back with `ObjectRequired`.
 * 3. An upload-attempt record is committed, so the orphan sweep can find an object whose outcome is
 *    unknown, then the file is written under a key made from the new Call id, then the transaction
 *    runs again.
 *
 * The five answers become: `created` (201), `existing` (200, the stored Call; a deleted one is
 * restored and a failed one with a transient reason is re-queued), `other_deal`
 * (`call.content_in_other_deal`, saying nothing about the other Call), `rights_required`
 * (`rights.confirmation_required` with the wording version) and `quota_exceeded`. A Call that is
 * not created leaves the new file with no owner and it is removed at once when the rollback is
 * certain, otherwise the orphan sweep removes it. The file is held in memory once, up to 5 MB.
 */
export async function upload(
  deps: CallDeps,
  context: CallContext,
  input: CallUploadInput
): Promise<CallUploadResult> {
  assertRole(context, PLAYBOOK_WRITE_ROLES)
  const checked = checkCallUpload(
    {
      fileName: input.fileName,
      declaredMediaType: input.declaredMediaType,
      sizeBytes: input.bytes.byteLength,
    },
    { dealId: input.dealId, rep: input.rep }
  )
  assertTranscriptContent(input.bytes, checked.mediaType)
  const organizationId = context.organizationId
  const contentHash = await sha256(input.bytes)
  const keyed: KeyedRequest = {
    key: input.idempotencyKey,
    organizationId,
    userId: context.userId,
    route: CALL_UPLOAD_IDEMPOTENCY_ROUTE,
    requestHash: requestHashOf(CALL_UPLOAD_IDEMPOTENCY_ROUTE, {
      contentHash: contentHash.toString('hex'),
      dealId: checked.dealId,
      rep: checked.rep,
    }),
  }
  const callId = formatId('call', crypto.randomUUID())
  const objectKey = callObjectKey(callId, checked.extension)
  let stored = false

  const decide = async (run: Run): Promise<UploadOutcome> => {
    await run(LOCK_TIMEOUT_SQL, [])
    // The key first, as every upload does: two calls with one key then queue on the key.
    const reservation = await reserveKey(run, keyed)
    if (reservation.kind === 'replay') {
      return reservation
    }
    if (!stored) {
      throw new ObjectRequired()
    }
    // The upload lock before the insert: the statement fails without it.
    await run(QUOTA_LOCK, [organizationId])
    const answer = (
      await run(CALL_INSERT, [
        organizationId,
        callId,
        checked.dealId,
        formatId('deal', crypto.randomUUID()),
        input.fileName,
        checked.mediaType,
        'transcript',
        input.bytes.byteLength,
        contentHash,
        context.userId,
        objectKey,
        'speaker',
        checked.rep.label,
        null,
        formatId('cjob', crypto.randomUUID()),
        DEFAULT_MAX_CALLS,
        DEFAULT_MAX_RECORDING_BYTES_TOTAL,
        deps.env.MAX_DEALS_PER_ORGANIZATION,
        CURRENT_RIGHTS_WORDING_VERSION,
      ])
    ).rows[0]
    switch (answer?.result) {
      case 'created': {
        const call = await readCall(run, organizationId, String(answer.id))
        await completeKey(run, keyed, 201, call)
        return { kind: 'done', status: 201, call, created: true }
      }
      case 'existing': {
        const id = String(answer.id)
        if (answer.state === 'deleted') {
          await run(CALL_RESTORE_FOR_UPLOAD, [
            organizationId,
            id,
            formatId('cjob', crypto.randomUUID()),
          ])
        } else if (
          answer.state === 'failed' &&
          callReuploadRequeues(
            (answer.failure_reason ?? null) as Parameters<typeof callReuploadRequeues>[0]
          )
        ) {
          await run(CALL_REQUEUE, [organizationId, id, formatId('cjob', crypto.randomUUID())])
        }
        const call = await readCall(run, organizationId, id)
        await completeKey(run, keyed, 200, call)
        return { kind: 'done', status: 200, call, created: false }
      }
      case 'other_deal':
        throw failure('call.content_in_other_deal')
      case 'rights_required':
        throw rightsRequired()
      case 'quota_exceeded':
        throw failure('call.quota_exceeded')
      default:
        throw new Error('the Call insert answered with a result the service does not know')
    }
  }

  for (let attempt = 0; ; attempt++) {
    let outcome: UploadOutcome
    try {
      outcome = await transaction(deps, organizationId, decide)
    } catch (error) {
      if (error instanceof ObjectRequired && attempt === 0) {
        await recordUploadAttempt(deps, context)
        try {
          await deps.objects.put(organizationId, objectKey, input.bytes, {
            contentType: checked.mediaType,
          })
        } catch (putError) {
          deps.logger.warn(
            'a Call upload failed with an unknown outcome; its file may be in place',
            {
              organizationId,
              callId,
            }
          )
          throw asStorageFailure(putError)
        }
        stored = true
        continue
      }
      if (stored) {
        await settleObject(deps, organizationId, objectKey, callId, rolledBack(error))
      }
      throw error
    }
    if (outcome.kind === 'replay') {
      if (stored) {
        await settleObject(deps, organizationId, objectKey, callId, true)
      }
      return {
        status: outcome.status === 201 ? 201 : 200,
        call: callSchema.parse(outcome.response),
      }
    }
    if (!outcome.created && stored) {
      // The content was already stored under an earlier Call: this copy is not needed.
      await settleObject(deps, organizationId, objectKey, callId, true)
    }
    return { status: outcome.status, call: outcome.call }
  }
}

/** Reads one Call in full inside a transaction. */
async function readCall(run: Run, organizationId: string, callId: string): Promise<Call> {
  const row = (await run(CALL_GET, [organizationId, callId])).rows[0]
  if (row === undefined) {
    throw new Error('a Call the upload just wrote could not be read back')
  }
  return toCall(row)
}

/** Reads one Call of the caller's Organization; another Organization's is `call.not_found`. */
export async function get(deps: CallDeps, context: CallContext, callId: string): Promise<Call> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const organizationId = context.organizationId
  const row = await transaction(
    deps,
    organizationId,
    async (run) => (await run(CALL_GET, [organizationId, callId])).rows[0]
  )
  if (row === undefined) {
    throw failure('call.not_found')
  }
  return toCall(row)
}

/** The position a Call-list cursor names, or `request.invalid` for a cursor that is not one. */
function readCursor(cursor: string): CallCursor {
  const decoded = decodeCursor(cursor, callCursorSchema)
  if (decoded === undefined) {
    throw failure('request.invalid')
  }
  return decoded
}

/**
 * One page of the Organization's Calls, newest first, by the statement's text cursor. With no
 * `state` the deleted ones are left out; one statement serves each combination of filters so each
 * keeps its index.
 */
export async function list(
  deps: CallDeps,
  context: CallContext,
  query: ListCallsQuery
): Promise<ListCallsResponse> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const organizationId = context.organizationId
  const after = query.cursor === undefined ? undefined : readCursor(query.cursor)
  const base = [organizationId, after?.createdAt ?? 'infinity', after?.id ?? '', query.limit]
  let statement = CALL_LIST
  let params: unknown[] = base
  if (query.dealRecordId !== undefined && query.state !== undefined) {
    statement = CALL_LIST_BY_DEAL_STATE
    params = [...base, query.dealRecordId, query.state]
  } else if (query.dealRecordId !== undefined) {
    statement = CALL_LIST_BY_DEAL
    params = [...base, query.dealRecordId]
  } else if (query.state !== undefined) {
    statement = CALL_LIST_BY_STATE
    params = [...base, query.state]
  }
  const rows = await mappingBadCursor(() =>
    transaction(deps, organizationId, async (run) => (await run(statement, params)).rows)
  )
  const last = rows.at(-1)
  return {
    items: rows.map((row) => toCall(row)),
    nextCursor:
      rows.length === query.limit && last !== undefined ? encodeCursor(callCursorOf(last)) : null,
  }
}

/** How long a deleted Call is kept before it is purged, as for documents. */
const RETENTION_MS = DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** Publishes a Call message after its commit; a failure is logged with ids only, because the sweeps and discovery recover the work. */
async function publishAfterCommit(
  deps: Pick<CallDeps, 'queue' | 'logger'>,
  context: Pick<CallContext, 'organizationId' | 'requestId'>,
  message:
    | { type: 'playbook.call_deleted'; payload: { callId: string; deletionSeq: number } }
    | { type: 'playbook.call_rep_changed'; payload: { callId: string; repSeq: number } }
): Promise<void> {
  try {
    await deps.queue.publish(
      registry.create({
        ...message,
        organizationId: context.organizationId,
        traceId: context.requestId,
      } as Parameters<typeof registry.create>[0])
    )
  } catch (error) {
    deps.logger.error('a committed Call change could not be published; the sweep will pick it up', {
      type: message.type,
      organizationId: context.organizationId,
      callId: message.payload.callId,
      error: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/**
 * Soft-deletes a Call: hidden from search at once (it is no longer `ready`), its job cancelled, its
 * vectors removed by the cleanup after the job's lease passes, and purged after the retention
 * period. Owner and Admin only. Idempotent by end state; the cleanup message is published only by
 * the call that changed the state, and a message lost in between is recovered by the
 * `call_cleanup` sweep.
 */
export async function remove(deps: CallDeps, context: CallContext, callId: string): Promise<Call> {
  assertRole(context, PLAYBOOK_WRITE_ROLES)
  const organizationId = context.organizationId
  const outcome = await transaction(deps, organizationId, async (run) => {
    // No row can also mean this call lost a race with another delete: once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = (
        await run(CALL_SOFT_DELETE, [organizationId, callId, context.userId, RETENTION_MS])
      ).rows[0]
      if (row !== undefined) {
        const read = (await run(CALL_GET, [organizationId, callId])).rows[0]
        return read === undefined
          ? undefined
          : {
              call: toCall(read),
              changed: row.changed === true,
              deletionSeq: Number(row.deletion_seq),
            }
      }
    }
    return undefined
  })
  if (outcome === undefined) {
    throw failure('call.not_found')
  }
  if (outcome.changed) {
    await publishAfterCommit(deps, context, {
      type: 'playbook.call_deleted',
      payload: { callId, deletionSeq: outcome.deletionSeq },
    })
  }
  return outcome.call
}

/**
 * Restores a soft-deleted Call within the retention period: it comes back `processing` and is
 * processed again from the kept Transcript. A Call that is no longer deleted is answered as it
 * is; a deleted one past its purge time, or one whose purge has started or that erasure barred, is
 * `call.not_restorable`; one that is gone is `call.not_found`. A restore before the vector cleanup
 * finished is safe: the cleanup deletes only up to the epoch it was begun at, and the restore
 * raised the epoch.
 */
export async function restore(deps: CallDeps, context: CallContext, callId: string): Promise<Call> {
  assertRole(context, PLAYBOOK_WRITE_ROLES)
  const organizationId = context.organizationId
  const jobId = formatId('cjob', crypto.randomUUID())
  const outcome = await transaction(deps, organizationId, async (run) => {
    await run(CALL_RESTORE, [organizationId, callId, jobId])
    const read = (await run(CALL_GET, [organizationId, callId])).rows[0]
    if (read === undefined) {
      return { kind: 'missing' as const }
    }
    if (read.state === 'deleted') {
      return { kind: 'gone' as const }
    }
    return { kind: 'ok' as const, call: toCall(read) }
  })
  if (outcome.kind === 'missing') {
    throw failure('call.not_found')
  }
  if (outcome.kind === 'gone') {
    throw failure('call.not_restorable')
  }
  return outcome.call
}

/** The statement parameters of a Rep choice: the kind, the speaker label and the channel (the other two null). */
function repParams(rep: SetCallRepRequest['rep']): [string, string | null, string | null] {
  return rep.by === 'speaker' ? ['speaker', rep.label, null] : ['channel', null, rep.channel]
}

/**
 * Picks or changes a Call's Rep. Owner and Admin only. The database decides in one statement
 * (`changed`, `unchanged`, `invalid`, `not_changeable`): a different Rep leaves the Call
 * `processing`, bumps `rep_seq` and queues a rebuild that replaces the Moments; the same Rep again
 * changes nothing and answers the Call as it is. The Rep-changed message is published only by the
 * change, and only nudges the rebuild, which `call_jobs` discovery finds anyway.
 */
export async function setRep(
  deps: CallDeps,
  context: CallContext,
  callId: string,
  request: SetCallRepRequest
): Promise<Call> {
  assertRole(context, PLAYBOOK_WRITE_ROLES)
  const organizationId = context.organizationId
  const [by, label, channel] = repParams(request.rep)
  const outcome = await transaction(deps, organizationId, async (run) => {
    const row = (
      await run(CALL_SET_REP, [
        organizationId,
        callId,
        by,
        label,
        channel,
        formatId('cjob', crypto.randomUUID()),
      ])
    ).rows[0]
    if (row === undefined) {
      return { kind: 'missing' as const }
    }
    if (row.result === 'invalid') {
      return { kind: 'invalid' as const }
    }
    if (row.result === 'not_changeable') {
      return { kind: 'not_changeable' as const }
    }
    const read = (await run(CALL_GET, [organizationId, callId])).rows[0]
    return read === undefined
      ? { kind: 'missing' as const }
      : {
          kind: 'ok' as const,
          call: toCall(read),
          changed: row.result === 'changed',
          repSeq: Number(row.rep_seq),
        }
  })
  if (outcome.kind === 'missing') {
    throw failure('call.not_found')
  }
  if (outcome.kind === 'invalid') {
    throw failure('call.rep_invalid')
  }
  if (outcome.kind === 'not_changeable') {
    throw failure('call.rep_not_changeable')
  }
  if (outcome.changed) {
    await publishAfterCommit(deps, context, {
      type: 'playbook.call_rep_changed',
      payload: { callId, repSeq: outcome.repSeq },
    })
  }
  return outcome.call
}
