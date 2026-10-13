import { createHash } from 'node:crypto'
import {
  checkUploadFile,
  DOCUMENT_RETENTION_DAYS,
  decodeCursor,
  documentSchema,
  ERRORS,
  encodeCursor,
  formatId,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  MEDIA_TYPE_BY_EXTENSION,
  normaliseMediaType,
  type OrganizationId,
  PLAYBOOK_ERRORS,
  PLAYBOOK_READ_ROLES,
  PLAYBOOK_WRITE_ROLES,
  type PlaybookDocument,
  type RequestId,
  type Role,
  type UserId,
} from 'tula-closeline-contract'
import {
  DOCUMENT_BY_HASH,
  DOCUMENT_ERASE_BATCH,
  DOCUMENT_GET,
  DOCUMENT_INSERT,
  DOCUMENT_LIST,
  DOCUMENT_LIST_DELETED,
  DOCUMENT_LIST_MAX_PAGE,
  DOCUMENT_REQUEUE,
  DOCUMENT_RESTORE,
  DOCUMENT_RESTORE_FOR_UPLOAD,
  DOCUMENT_SOFT_DELETE,
  ORGANIZATION_REMOVAL_STATUS,
  ORGANIZATION_REMOVE_REST,
  QUOTA_LOCK,
  QUOTA_USAGE,
  REMOVE_ALL_IDEMPOTENCY_ROUTE,
} from 'tula-closeline-db'
import { INTERNAL_CALL_USER_ID } from 'tula-closeline-db/schema'
import { StorageError } from 'tula-closeline-kit'
import type { Run } from '~/adapters/postgres/processed-store'
import {
  DEADLOCK_DETECTED,
  isLockTimeout,
  postgresErrorOf,
  retryTransaction,
  SERIALIZATION_FAILURE,
} from '~/adapters/postgres/retry'
import type { Container } from '~/container'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { registry } from '~/messages'
import { detectDocumentType } from './detect'
import {
  completeKey,
  findKey,
  type KeyedRequest,
  LOCK_TIMEOUT_SQL,
  RETRY_AFTER_SECONDS,
  requestHashOf,
  reserveKey,
} from './idempotency'
import {
  type ListCursor,
  type ListRow,
  listCursorSchema,
  listRowSchema,
  toDocument,
} from './schema'

/** What the document service needs from the container. */
export type DocumentDeps = Pick<Container, 'scope' | 'objects' | 'queue' | 'logger' | 'env'>

/** Who is calling and which request it is: the Organization and role come from the verified token only. */
export type CallContext = {
  userId: UserId
  organizationId: OrganizationId
  role: Role
  requestId: RequestId
}

/** The route name a keyed upload stores its key under. */
export const UPLOAD_IDEMPOTENCY_ROUTE = 'documents.upload'

/** The retention of a soft-deleted document, in milliseconds, which `DOCUMENT_SOFT_DELETE` adds to the database clock. */
const RETENTION_MS = DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** How much of the file is fed to the hash at once before the event loop gets a turn. */
const HASH_SLICE_BYTES = 4 * 1024 * 1024

/** The documents an erase batch of the remove-all route takes; the database clamps it to 500. */
export const ERASE_BATCH_SIZE = 100

/** The erase batches one remove-all request runs: a constant, so the request is bounded whatever the Organization holds. */
export const ERASE_BATCHES_PER_REQUEST = 5

/** The most list pages scanned to fill one page that is filtered by a state the database cannot filter on. */
export const MAX_FILTER_SCAN_PAGES = 6

/** What a list statement is asked for on a scan: the biggest page the database gives. */
const SCAN_PAGE = DOCUMENT_LIST_MAX_PAGE

const ALL_ERRORS = { ...ERRORS, ...PLAYBOOK_ERRORS }

/** The AppError for a code the contract's checks or the database's answers can name. */
function failure(code: keyof typeof ALL_ERRORS) {
  return domainError(ALL_ERRORS[code])
}

/** Refuses a caller whose role is not in `roles` with the common `auth.forbidden`. */
export function assertRole(context: Pick<CallContext, 'role'>, roles: readonly Role[]): void {
  if (!roles.includes(context.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
}

/**
 * Refuses a file part that is too large, of an unsupported type or malformed, from what is known
 * before its bytes are read: the name, the declared type and the size the multipart parser counted.
 * `maxBytes` is the instance's own `MAX_UPLOAD_BYTES`, which may be lower than the contract's.
 * The upload runs the same check again on the bytes it holds.
 */
export function assertUploadable(
  file: { fileName: string; declaredMediaType: string | null; sizeBytes: number },
  maxBytes: number
): void {
  if (file.sizeBytes > maxBytes) {
    throw failure('document.too_large')
  }
  const checked = checkUploadFile(file)
  if (!checked.ok) {
    throw failure(checked.code)
  }
}

/** The SHA-256 of `bytes`, fed in slices with a turn for the event loop between them. */
export async function sha256(bytes: Uint8Array): Promise<Buffer> {
  const hash = createHash('sha256')
  for (let offset = 0; offset < bytes.byteLength; offset += HASH_SLICE_BYTES) {
    hash.update(bytes.subarray(offset, offset + HASH_SLICE_BYTES))
    if (offset + HASH_SLICE_BYTES < bytes.byteLength) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return hash.digest()
}

/** Reads one document in full, or `undefined`; the Organization comes from the transaction's scope as well as the statement. */
async function readDocument(
  run: Run,
  organizationId: string,
  documentId: string
): Promise<
  { document: PlaybookDocument; deletionSeq: number; notRestorable: boolean } | undefined
> {
  const row = (await run(DOCUMENT_GET, [organizationId, documentId])).rows[0]
  if (row === undefined) {
    return undefined
  }
  return {
    document: toDocument(row),
    deletionSeq: Number(row.deletion_seq),
    notRestorable: row.not_restorable === true,
  }
}

/**
 * The errors raised while a transaction's work was running, before its commit was sent. Such an
 * error means the transaction did not commit, whatever it was (a statement the server refused, a
 * dropped connection, a bug), because the commit is only sent after the work returns. An error
 * that is not in this set came from before the work or from the commit or release, where the
 * server may or may not have applied the change.
 */
const raisedBeforeCommit = new WeakSet<object>()

/** Makes a transaction that can run again after a deadlock or a serialization failure, then maps a lock timeout to a retryable 503. */
async function transaction<T>(
  deps: Pick<DocumentDeps, 'scope'>,
  organizationId: string,
  work: (run: Run) => Promise<T>
): Promise<T> {
  const marked = async (run: Run): Promise<T> => {
    try {
      return await work(run)
    } catch (error) {
      if (typeof error === 'object' && error !== null) {
        raisedBeforeCommit.add(error)
      }
      throw error
    }
  }
  try {
    return await retryTransaction(() => deps.scope(organizationId, marked))
  } catch (error) {
    if (isLockTimeout(error)) {
      const busy = new RetryAfterError(ERRORS['server.unavailable'], RETRY_AFTER_SECONDS)
      if (typeof error === 'object' && error !== null && raisedBeforeCommit.has(error)) {
        raisedBeforeCommit.add(busy)
      }
      throw busy
    }
    throw error
  }
}

/** Publishes after the commit. A failure here changes nothing the caller was told: it is logged, and the sweep recovers the work. */
async function publishAfterCommit(
  deps: Pick<DocumentDeps, 'queue' | 'logger'>,
  context: Pick<CallContext, 'organizationId' | 'requestId'>,
  message:
    | { type: 'playbook.document_uploaded'; payload: { documentId: string } }
    | { type: 'playbook.document_deleted'; payload: { documentId: string; deletionSeq: number } }
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
    deps.logger.error('a committed change could not be published; the sweep will pick it up', {
      type: message.type,
      organizationId: context.organizationId,
      documentId: message.payload.documentId,
      error: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/** Thrown inside the upload transaction when it would insert a document but the file is not in the object store yet. */
class ObjectRequired extends Error {}

/** What the upload transaction decided. */
type UploadOutcome =
  | { kind: 'replay'; status: number; response: unknown }
  | {
      kind: 'done'
      status: 200 | 201
      document: PlaybookDocument
      /** Set when the document must now be ingested: publish the uploaded message. */
      publish: boolean
      /** True when this call inserted a row for the object it wrote. */
      inserted: boolean
    }

/** What an upload brings, once the HTTP layer has read it. */
export type UploadInput = {
  fileName: string
  declaredMediaType: string | null
  bytes: Uint8Array
  idempotencyKey: string | undefined
}

/** What an upload answers: the status (201 new, 200 existing) and the document. */
export type UploadResult = { status: 200 | 201; document: PlaybookDocument }

/** The declared type as the table stores it: printable ASCII, 1 to 255 characters, else a neutral value. */
function storedDeclaredType(declared: string | null): string {
  const normalised = declared === null ? '' : normaliseMediaType(declared)
  return /^[ -~]{1,255}$/.test(normalised) ? normalised : 'application/octet-stream'
}

/**
 * Whether a failed transaction certainly left no row, so the file written for it can go. That is
 * so when the error was raised while the work ran (the commit was never sent), and when the server
 * answered the commit itself with a rollback: a serialization failure, a deadlock or a constraint
 * violation (class 23). Any other error at or after the commit (a shutdown code such as 57P01, a
 * connection error of class 08, a socket error such as EPIPE) leaves the outcome unknown.
 */
function rolledBack(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && raisedBeforeCommit.has(error)) {
    return true
  }
  const code = postgresErrorOf(error)?.code
  return (
    code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED || code?.startsWith('23') === true
  )
}

/** Maps what the object store can fail with to the contract: unavailable is retryable, anything else is ours. */
function asStorageFailure(error: unknown): unknown {
  if (error instanceof StorageError && error.code === 'storage.unavailable') {
    return new RetryAfterError(ERRORS['server.unavailable'], RETRY_AFTER_SECONDS)
  }
  return error
}

/**
 * Stores one uploaded file. Owner and Admin only. The order, and why:
 *
 * 1. Check the file (size, type by name, shape), then its content against the name's type, then
 *    hash it. Nothing is stored yet.
 * 2. One transaction decides: claim the idempotency key, take the Organization's quota lock, find a
 *    duplicate by content hash (an existing document is answered, a deleted one restored, a failed
 *    one requeued), check the quota (soft-deleted documents count), and only then insert. When the
 *    insert is the next step and the file is not stored, the transaction rolls back with
 *    `ObjectRequired`.
 * 3. The file is written to the object store under a key made from the new document id, never the
 *    file name, and the transaction runs again. So a duplicate, a replay or a quota refusal never
 *    writes a file.
 * 4. After the commit, `playbook.document_uploaded` is published. Nothing publishes inside a
 *    transaction.
 *
 * Crash points: before the object write nothing exists; after the object write and before the
 * commit the file is an orphan no row names (invisible, removed at once when the failure is certain
 * to have rolled back, left for an orphan sweep when it is not, because a lost commit answer may
 * have committed the row); after the commit the document is `uploaded` with a queued job, which the
 * job loop finds without the message (`jobs_due`), so a lost publish only costs latency.
 *
 * The hash and the file's bytes are held in memory, as ADR 0016 accepts; the whole call holds the
 * request's bytes once plus what the multipart parser kept (see the module's README note in
 * AGENTS.md).
 */
export async function upload(
  deps: DocumentDeps,
  context: CallContext,
  input: UploadInput
): Promise<UploadResult> {
  assertRole(context, PLAYBOOK_WRITE_ROLES)
  const checked = checkUploadFile({
    fileName: input.fileName,
    declaredMediaType: input.declaredMediaType,
    sizeBytes: input.bytes.byteLength,
  })
  if (!checked.ok) {
    throw failure(checked.code)
  }
  if (input.bytes.byteLength > deps.env.MAX_UPLOAD_BYTES) {
    throw failure('document.too_large')
  }
  const fileName = checked.file.fileName
  const fileType = detectDocumentType(input.bytes, fileName)
  if (fileType === undefined) {
    throw failure('document.unsupported_type')
  }
  const contentHash = await sha256(input.bytes)
  const organizationId = context.organizationId
  const keyed: KeyedRequest = {
    key: input.idempotencyKey,
    organizationId,
    userId: context.userId,
    route: UPLOAD_IDEMPOTENCY_ROUTE,
    requestHash: requestHashOf(UPLOAD_IDEMPOTENCY_ROUTE, {
      fileName,
      contentHash: contentHash.toString('hex'),
    }),
  }
  const documentId = formatId('doc', crypto.randomUUID())
  const jobId = formatId('job', crypto.randomUUID())
  const objectKey = `documents/${documentId}/original.${fileType}`
  const declaredType = storedDeclaredType(input.declaredMediaType)
  let stored = false

  const decide = (run: Run): Promise<UploadOutcome> =>
    uploadTransaction(run, {
      deps,
      context,
      keyed,
      fileName,
      fileType,
      contentHash,
      sizeBytes: input.bytes.byteLength,
      declaredType,
      documentId,
      jobId,
      objectKey,
      objectStored: () => stored,
    })

  for (let attempt = 0; ; attempt++) {
    let outcome: UploadOutcome
    try {
      outcome = await transaction(deps, organizationId, decide)
    } catch (error) {
      if (error instanceof ObjectRequired && attempt === 0) {
        try {
          await deps.objects.put(organizationId, objectKey, input.bytes, {
            contentType: MEDIA_TYPE_BY_EXTENSION[`.${fileType}`],
          })
        } catch (putError) {
          throw asStorageFailure(putError)
        }
        stored = true
        continue
      }
      if (stored) {
        await settleObject(deps, organizationId, objectKey, documentId, rolledBack(error))
      }
      throw error
    }
    if (stored && !(outcome.kind === 'done' && outcome.inserted)) {
      // Another upload of the same content, or of the same key, committed first: this file was not needed.
      await settleObject(deps, organizationId, objectKey, documentId, true)
    }
    if (outcome.kind === 'replay') {
      const document = documentSchema.safeParse(outcome.response)
      if ((outcome.status !== 200 && outcome.status !== 201) || !document.success) {
        throw new Error('A stored upload answer can no longer be read')
      }
      return { status: outcome.status, document: document.data }
    }
    if (outcome.publish) {
      await publishAfterCommit(deps, context, {
        type: 'playbook.document_uploaded',
        payload: { documentId: outcome.document.id },
      })
    }
    return { status: outcome.status, document: outcome.document }
  }
}

/** Removes the object of an upload that left no row, when that is certain; otherwise leaves it and says so. */
async function settleObject(
  deps: Pick<DocumentDeps, 'objects' | 'logger'>,
  organizationId: string,
  objectKey: string,
  documentId: string,
  certain: boolean
): Promise<void> {
  if (!certain) {
    deps.logger.warn('an upload failed with an unknown outcome; its file is left in place', {
      organizationId,
      documentId,
    })
    return
  }
  try {
    await deps.objects.delete(organizationId, objectKey)
  } catch (error) {
    deps.logger.warn('the file of a document that was not stored could not be removed', {
      organizationId,
      documentId,
      error: error instanceof Error ? error.name : 'unknown',
    })
  }
}

type UploadPlan = {
  deps: Pick<DocumentDeps, 'env'>
  context: CallContext
  keyed: KeyedRequest
  fileName: string
  fileType: string
  contentHash: Buffer
  sizeBytes: number
  declaredType: string
  documentId: string
  jobId: string
  objectKey: string
  objectStored: () => boolean
}

/** The transaction of {@link upload}: everything that is decided in the database, in the order that avoids a deadlock. */
async function uploadTransaction(run: Run, plan: UploadPlan): Promise<UploadOutcome> {
  const { context, keyed } = plan
  const organizationId = context.organizationId
  await run(LOCK_TIMEOUT_SQL, [])
  // The key first, then the Organization's lock: two calls with one key then queue on the key.
  const reservation = await reserveKey(run, keyed)
  if (reservation.kind === 'replay') {
    return reservation
  }
  await run(QUOTA_LOCK, [organizationId])

  const done = async (
    status: 200 | 201,
    documentId: string,
    publish: boolean,
    inserted: boolean
  ): Promise<UploadOutcome> => {
    const read = await readDocument(run, organizationId, documentId)
    if (read === undefined) {
      throw new Error('A document the upload just wrote could not be read back')
    }
    await completeKey(run, keyed, status, read.document)
    return { kind: 'done', status, document: read.document, publish, inserted }
  }

  const match = (await run(DOCUMENT_BY_HASH, [organizationId, plan.contentHash])).rows[0]
  if (match !== undefined) {
    const id = String(match.id)
    if (match.state === 'deleted') {
      const restored = await run(DOCUMENT_RESTORE_FOR_UPLOAD, [organizationId, id, plan.jobId])
      // No row means the purge claimed it first: the old document no longer blocks a new one.
      if (restored.rows.length > 0) {
        return done(200, id, restored.rows[0]?.changed === true, false)
      }
    } else if (match.state === 'failed') {
      const requeued = await run(DOCUMENT_REQUEUE, [organizationId, id, plan.jobId])
      return done(200, id, requeued.rows[0]?.changed === true, false)
    } else {
      return done(200, id, false, false)
    }
  }

  const usage = (await run(QUOTA_USAGE, [organizationId])).rows[0]
  const documents = Number(usage?.document_count ?? 0)
  const bytes = Number(usage?.byte_count ?? 0)
  const { MAX_DOCUMENTS_PER_ORGANIZATION: maxDocuments, MAX_BYTES_PER_ORGANIZATION: maxBytes } =
    plan.deps.env
  if (documents >= maxDocuments || bytes + plan.sizeBytes > maxBytes) {
    throw failure('document.quota_exceeded')
  }
  if (!plan.objectStored()) {
    throw new ObjectRequired()
  }
  const inserted = await run(DOCUMENT_INSERT, [
    organizationId,
    plan.documentId,
    plan.fileName,
    plan.contentHash,
    plan.sizeBytes,
    plan.declaredType,
    plan.fileType,
    context.userId,
    plan.objectKey,
    plan.jobId,
    maxDocuments,
    maxBytes,
  ])
  if (inserted.rows.length === 0) {
    // The lock is held and the hash and quota were checked above, so only a quota the numbers above missed lands here.
    throw failure('document.quota_exceeded')
  }
  return done(201, plan.documentId, true, true)
}

/** Reads one document of the caller's Organization; another Organization's, or a purged one, is `document.not_found`. */
export async function get(
  deps: DocumentDeps,
  context: CallContext,
  documentId: string
): Promise<PlaybookDocument> {
  assertRole(context, PLAYBOOK_READ_ROLES)
  const read = await transaction(deps, context.organizationId, (run) =>
    readDocument(run, context.organizationId, documentId)
  )
  if (read === undefined) {
    throw failure('document.not_found')
  }
  return read.document
}

/** Encodes the position after `row` as a cursor. */
function cursorAfter(row: ListRow): string {
  const cursor: ListCursor = { t: row.created_at, i: row.id }
  return encodeCursor(cursor)
}

/**
 * Lists the Organization's documents, newest first, one page at a time, at most 100. Deleted
 * documents only when `state=deleted` is asked for. The database can filter on "deleted or not"
 * but not on one state, so a page filtered by another state scans up to {@link MAX_FILTER_SCAN_PAGES}
 * pages of 100 (a constant, covering the default quota) and may return fewer than `limit` with a
 * cursor to continue from the last row it looked at.
 */
export async function list(
  deps: DocumentDeps,
  context: CallContext,
  query: ListDocumentsQuery
): Promise<ListDocumentsResponse> {
  assertRole(context, PLAYBOOK_READ_ROLES)
  let after: ListCursor | undefined
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, listCursorSchema)
    if (after === undefined) {
      throw failure('request.invalid')
    }
  }
  const { limit } = query
  const wantDeleted = query.state === 'deleted'
  const filter = query.state !== undefined && !wantDeleted ? query.state : undefined
  const statement = wantDeleted ? DOCUMENT_LIST_DELETED : DOCUMENT_LIST
  const organizationId = context.organizationId

  return transaction(deps, organizationId, async (run) => {
    const picked: ListRow[] = []
    let position = after
    let scanned: ListRow | undefined
    let more = false
    const pages = filter === undefined ? 1 : MAX_FILTER_SCAN_PAGES
    for (let page = 0; page < pages && picked.length < limit; page++) {
      const size = filter === undefined ? limit : SCAN_PAGE
      const result = await run(statement, [
        organizationId,
        position?.t ?? 'infinity',
        position?.i ?? '',
        size,
      ])
      const rows = result.rows.map((row) => listRowSchema.parse(row))
      more = rows.length === size
      for (const row of rows) {
        scanned = row
        if (filter === undefined || row.state === filter) {
          picked.push(row)
          if (picked.length === limit) {
            break
          }
        }
      }
      const last = rows.at(-1)
      if (last === undefined || picked.length === limit) {
        break
      }
      position = { t: last.created_at, i: last.id }
    }
    const items: PlaybookDocument[] = []
    for (const row of picked) {
      const read = await readDocument(run, organizationId, row.id)
      if (read !== undefined) {
        items.push(read.document)
      }
    }
    const full = picked.length === limit
    const resumeFrom = full ? picked.at(-1) : scanned
    return {
      items,
      nextCursor: (full || more) && resumeFrom !== undefined ? cursorAfter(resumeFrom) : null,
    }
  })
}

/**
 * Soft-deletes a document: hidden at once, purged after the retention period. Owner and Admin
 * only. Idempotent by end state; the cleanup message is published only by the call that changed
 * the state, so a repeat publishes nothing. A cleanup message lost between the commit and the
 * publish is recovered by the `cleanup_pending` sweep.
 */
export async function remove(
  deps: DocumentDeps,
  context: CallContext,
  documentId: string
): Promise<PlaybookDocument> {
  assertRole(context, PLAYBOOK_WRITE_ROLES)
  const organizationId = context.organizationId
  const outcome = await transaction(deps, organizationId, async (run) => {
    // No row can also mean this call lost a race with another delete (db README): once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = (
        await run(DOCUMENT_SOFT_DELETE, [organizationId, documentId, context.userId, RETENTION_MS])
      ).rows[0]
      if (row !== undefined) {
        const read = await readDocument(run, organizationId, documentId)
        return read === undefined
          ? undefined
          : {
              document: read.document,
              changed: row.changed === true,
              deletionSeq: Number(row.deletion_seq),
            }
      }
    }
    return undefined
  })
  if (outcome === undefined) {
    throw failure('document.not_found')
  }
  if (outcome.changed) {
    await publishAfterCommit(deps, context, {
      type: 'playbook.document_deleted',
      payload: { documentId, deletionSeq: outcome.deletionSeq },
    })
  }
  return outcome.document
}

/**
 * Restores a soft-deleted document within the retention period. Owner and Admin only. A document
 * that is no longer deleted is answered as it is; a deleted one past its purge time (by the
 * database clock) is `document.not_restorable`; one that is gone is `document.not_found`.
 */
export async function restore(
  deps: DocumentDeps,
  context: CallContext,
  documentId: string
): Promise<PlaybookDocument> {
  assertRole(context, PLAYBOOK_WRITE_ROLES)
  const organizationId = context.organizationId
  const jobId = formatId('job', crypto.randomUUID())
  const outcome = await transaction(deps, organizationId, async (run) => {
    const row = (await run(DOCUMENT_RESTORE, [organizationId, documentId, jobId])).rows[0]
    const read = await readDocument(run, organizationId, documentId)
    if (read === undefined) {
      return { kind: 'missing' as const }
    }
    if (row === undefined && read.document.state === 'deleted') {
      return { kind: 'gone' as const }
    }
    return { kind: 'ok' as const, document: read.document, changed: row?.changed === true }
  })
  if (outcome.kind === 'missing') {
    throw failure('document.not_found')
  }
  if (outcome.kind === 'gone') {
    throw failure('document.not_restorable')
  }
  if (outcome.changed) {
    await publishAfterCommit(deps, context, {
      type: 'playbook.document_uploaded',
      payload: { documentId },
    })
  }
  return outcome.document
}

/** The answer of the remove-all route. */
export type RemoveAllResult = { organizationId: OrganizationId; status: 'removed' }

/**
 * The internal remove-all call (ADR 0016, offboarding and erasure). It does bounded work, never
 * work that grows with the Organization: up to {@link ERASE_BATCHES_PER_REQUEST} batches of
 * {@link ERASE_BATCH_SIZE} documents are barred from restore and made due for purge, the vector
 * cleanup of each document that changed is published, and then the Organization's end state is
 * read. It answers `removed` only when nothing remains, as the contract defines it: no document
 * row (the purge sweep removes the file and the row of the barred ones) and the rest removed. When
 * documents remain it answers `server.unavailable` (503) with `Retry-After`, and the caller
 * repeats the call until it answers 200; each repeat erases more and re-reads the end state. The
 * idempotency key is stored only with the final answer, so a repeat after 503 is a new attempt.
 */
export async function removeAll(
  deps: DocumentDeps,
  organizationId: OrganizationId,
  requestId: RequestId,
  idempotencyKey: string,
  options: { publishBudgetMs?: number } = {}
): Promise<RemoveAllResult> {
  const keyed: KeyedRequest = {
    key: idempotencyKey,
    organizationId,
    userId: INTERNAL_CALL_USER_ID,
    route: REMOVE_ALL_IDEMPOTENCY_ROUTE,
    requestHash: requestHashOf(REMOVE_ALL_IDEMPOTENCY_ROUTE, { organizationId }),
  }
  const answer: RemoveAllResult = { organizationId, status: 'removed' }
  const context = { organizationId, requestId }

  const earlier = await transaction(deps, organizationId, async (run) => {
    await run(LOCK_TIMEOUT_SQL, [])
    return findKey(run, keyed)
  })
  if (earlier !== undefined) {
    return answer
  }

  const cleanups: { documentId: string; deletionSeq: number }[] = []
  for (let batch = 0; batch < ERASE_BATCHES_PER_REQUEST; batch++) {
    const erased = await transaction(
      deps,
      organizationId,
      async (run) =>
        (await run(DOCUMENT_ERASE_BATCH, [organizationId, ERASE_BATCH_SIZE, INTERNAL_CALL_USER_ID]))
          .rows
    )
    for (const row of erased) {
      if (row.changed === true) {
        cleanups.push({ documentId: String(row.id), deletionSeq: Number(row.deletion_seq) })
      }
    }
    if (erased.length === 0) {
      break
    }
  }
  await publishCleanups(deps, context, cleanups, options.publishBudgetMs ?? PUBLISH_BUDGET_MS)

  const finished = await transaction(deps, organizationId, async (run) => {
    await run(LOCK_TIMEOUT_SQL, [])
    const status = (await run(ORGANIZATION_REMOVAL_STATUS, [organizationId])).rows[0]
    if (status?.no_documents !== true) {
      // Nothing is written, so no key row is left in flight.
      return false
    }
    if ((await reserveKey(run, keyed)).kind === 'replay') {
      return true
    }
    // Refuses, and deletes nothing, while any document row exists.
    await run(ORGANIZATION_REMOVE_REST, [organizationId, REMOVE_ALL_IDEMPOTENCY_ROUTE])
    const after = (await run(ORGANIZATION_REMOVAL_STATUS, [organizationId])).rows[0]
    if (after?.removed !== true) {
      // A document or a consumed message appeared meanwhile: roll the key back with everything else.
      throw new RemovalIncomplete()
    }
    await completeKey(run, keyed, 200, answer)
    return true
  }).catch((error: unknown) => {
    if (error instanceof RemovalIncomplete) {
      return false
    }
    throw error
  })
  if (!finished) {
    throw new RetryAfterError(ERRORS['server.unavailable'], REMOVAL_RETRY_AFTER_SECONDS)
  }
  return answer
}

/** How many cleanup messages a remove-all publishes at once. */
export const PUBLISH_CONCURRENCY = 8

/** How long a remove-all spends publishing cleanup messages; the rest are left to the `cleanup_pending` sweep. */
export const PUBLISH_BUDGET_MS = 5000

/**
 * Publishes the deleted-document messages of a remove-all, {@link PUBLISH_CONCURRENCY} at a time,
 * and starts no new one once `budgetMs` has passed. A message not published here is not lost: its
 * document is `cleanup_pending`, and the sweep publishes it. Each publish already has its own
 * timeout in the queue adapter, so this call ends within the budget plus one publish.
 */
async function publishCleanups(
  deps: Pick<DocumentDeps, 'queue' | 'logger'>,
  context: Pick<CallContext, 'organizationId' | 'requestId'>,
  cleanups: readonly { documentId: string; deletionSeq: number }[],
  budgetMs: number
): Promise<void> {
  const deadline = performance.now() + budgetMs
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < cleanups.length && performance.now() < deadline) {
      const cleanup = cleanups[next++]
      if (cleanup !== undefined) {
        await publishAfterCommit(deps, context, {
          type: 'playbook.document_deleted',
          payload: cleanup,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PUBLISH_CONCURRENCY, cleanups.length) }, worker))
  if (next < cleanups.length) {
    deps.logger.warn('a remove-all left cleanup messages for the sweep', {
      organizationId: context.organizationId,
      left: cleanups.length - next,
    })
  }
}

/** What a caller of an unfinished remove-all is told to wait: the purge sweep needs a moment. */
export const REMOVAL_RETRY_AFTER_SECONDS = 30

/** Ends the final transaction of a remove-all that found the Organization not yet empty, rolling its key back. */
class RemovalIncomplete extends Error {}
