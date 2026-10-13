import {
  CONSUMED_CLAIM,
  CONSUMED_COMPLETE,
  CONSUMED_LOOKUP,
  CONSUMED_PURGE,
  CONSUMED_PURGE_AGE_MS,
  CONSUMED_RELEASE,
  CONSUMED_RENEW,
  DOCUMENT_BY_HASH,
  DOCUMENT_CLEANUP_BEGIN,
  DOCUMENT_CLEANUP_DONE,
  DOCUMENT_ERASE_BATCH,
  DOCUMENT_GET,
  DOCUMENT_INSERT,
  DOCUMENT_LIST_FILTERED,
  DOCUMENT_LIST_MAX_PAGE,
  DOCUMENT_LIST_SPENT_PURGES,
  DOCUMENT_MIN_RETENTION_MS,
  DOCUMENT_PURGE_CLAIM,
  DOCUMENT_PURGE_COMPLETE,
  DOCUMENT_REQUEUE,
  DOCUMENT_RESTORE,
  DOCUMENT_RESTORE_FOR_UPLOAD,
  DOCUMENT_SOFT_DELETE,
  IDEMPOTENCY_BEGIN,
  IDEMPOTENCY_COMPLETE,
  IDEMPOTENCY_LOOKUP,
  IDEMPOTENCY_MIN_PURGE_AGE_MS,
  IDEMPOTENCY_PURGE,
  IDEMPOTENCY_PURGE_AGE_MS,
  INDEX_SETTINGS_UPSERT,
  INDEX_VECTORS_MARK,
  INGESTION_JOB_ADVANCE,
  INGESTION_JOB_CLAIM,
  INGESTION_JOB_COMPLETE,
  INGESTION_JOB_FAIL,
  INGESTION_JOB_GIVE_UP_SPENT,
  INGESTION_JOB_HEARTBEAT,
  INGESTION_JOB_RETRY,
  INGESTION_MAX_RETRY_DELAY_MS,
  ORGANIZATION_REMOVAL_STATUS,
  ORGANIZATION_REMOVE_REST,
  ORGANIZATIONS_WITH_WORK,
  PLAYBOOK_MAX_BATCH,
  PLAYBOOK_MIN_LEASE_MS,
  QUOTA_LOCK,
  QUOTA_USAGE,
} from 'tula-closeline-db'
import {
  DOCUMENT_FAILURE_REASONS,
  DOCUMENT_MAX_PAGE_COUNT,
  DOCUMENT_PURGE_MAX_ATTEMPTS,
  INGESTION_JOB_MAX_ATTEMPTS,
  INGESTION_MAX_CHUNKS,
  INGESTION_STEPS,
} from 'tula-closeline-db/schema'
import type { Clock } from 'tula-closeline-kit'
import type { Discover, InScope, Result, Run } from '~/adapters/postgres/processed-store'
import { CLEANUP_PENDING_AFTER_MS } from '~/modules/ingestion/runtime'

/** One row of `playbook.documents`, as far as the document routes read or write it. */
export type MemoryDocumentRow = {
  id: string
  organization_id: string
  name: string
  content_hash: string
  size_bytes: number
  declared_type: string
  detected_type: string
  uploaded_by: string
  object_key: string
  state: 'uploaded' | 'processing' | 'ready' | 'failed' | 'deleted'
  failure_reason: string | null
  epoch: number
  deletion_seq: number
  deleted_at: number | null
  deleted_by: string | null
  purge_due_at: number | null
  purge_started_at: number | null
  /** The pages the ingestion job counted; null until it records them. */
  page_count: number | null
  restore_barred_at: number | null
  /** The deletion whose vector cleanup was recorded; null until one is. */
  vectors_removed_seq: number | null
  /** Purge claims made so far; the table bounds it at the db library's maximum. */
  purge_attempts: number
  /** The end of the purge claim's lease, or null. */
  purge_lease_until: number | null
  created_at: number
  updated_at: number
}

/** One row of `playbook.ingestion_jobs`. */
export type MemoryJobRow = {
  id: string
  organization_id: string
  document_id: string
  epoch: number
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  step: (typeof INGESTION_STEPS)[number]
  attempts: number
  /** The due time while queued and the end of the lease while running or cancelled mid-run. */
  next_attempt_at: number
  claim_token: string | null
  artifact_key: string | null
  page_count: number | null
  chunk_count: number | null
  chunks_done: number
  failure_reason: string | null
}

/** One row of `playbook.index_settings`. */
export type MemorySettingsRow = {
  organization_id: string
  embedding_model: string
  embedding_dimension: number
  vectors_written_at: number | null
}

/** One row of `playbook.consumed_message`. */
export type MemoryConsumedRow = {
  consumer: string
  organization_id: string
  message_id: string
  state: 'claimed' | 'done'
  claim_token: string
  lease_expires_at: number | null
  completed_at: number | null
}

type KeyRow = {
  organization_id: string
  user_id: string
  route: string
  key: string
  request_hash: string
  status: number | null
  response: unknown
  created_at: number
}

type State = {
  documents: MemoryDocumentRow[]
  jobs: MemoryJobRow[]
  keys: KeyRow[]
  settings: MemorySettingsRow[]
  consumed: MemoryConsumedRow[]
  /** Organizations whose `organization_usage` row exists: set by the first insert, kept until removed. */
  usage: Set<string>
}

/** A Postgres-style failure the double raises on request: an error carrying a SQLSTATE `code`. */
export function postgresError(code: string, message = `postgres ${code}`): Error {
  return Object.assign(new Error(message), { code })
}

/** The part of `MemoryPlaybookDatabase` a test uses to look at and break the database. */
export type MemoryPlaybookDatabase = {
  /** The Organization-scoped helper the container hands out: transactions that roll back on a throw. */
  scope: InScope
  /** The committed documents of an Organization, oldest first. */
  documents(organizationId: string): MemoryDocumentRow[]
  /** The committed jobs of an Organization. */
  jobs(organizationId: string): MemoryJobRow[]
  /** The Organization's index settings row, if one exists. */
  settings(organizationId: string): MemorySettingsRow | undefined
  /** The committed consumed-message records of an Organization (or the global scope). */
  consumed(organizationId: string): MemoryConsumedRow[]
  /**
   * The db library's work discovery, run the only way Postgres allows: unscoped, one statement,
   * its own transaction. Finds Organizations that have due work of `kind`, in id order after
   * `after`, at most `batch`. Inside a scope the same statement raises `42501`, as the real one does.
   */
  discover: Discover
  /** How many discovery calls were made, so a test can see a sweep used the unscoped path. */
  readonly discoveries: { kind: string; after: string }[]
  /** The committed idempotency keys of an Organization. */
  keys(organizationId: string): readonly KeyRow[]
  /** Adds a committed row directly, for a state the routes cannot reach (a purge in progress). */
  seed(row: Partial<MemoryDocumentRow> & Pick<MemoryDocumentRow, 'id' | 'organization_id'>): void
  /** Seeds an idempotency key that is still in flight (status null), which a crashed run could not leave. */
  seedKeyInFlight(
    key: Pick<KeyRow, 'organization_id' | 'user_id' | 'route' | 'key'> & { request_hash: string }
  ): void
  /** Changes committed rows directly, as another instance's transaction would. */
  update(organizationId: string, id: string, change: Partial<MemoryDocumentRow>): void
  /** Removes every document of an Organization, as round B's purge will; the usage row stays. */
  purgeAll(organizationId: string): void
  /** Makes the next run of this statement text fail with `error` (once), inside whatever transaction runs it. */
  failNext(statement: string, error: Error): void
  /** Makes every run of this statement text fail with `error` until `clearFailures`. */
  failAlways(statement: string, error: Error): void
  /**
   * Makes the next commit fail with `error` after the work ran: `applied` says whether the change
   * was nonetheless made (the server committed and the answer was lost) or not (it was rolled back).
   */
  failNextCommit(error: Error, options: { applied: boolean }): void
  /** Forgets every injected failure. */
  clearFailures(): void
  /** The text of every statement run, in order, so a test can count the reads a call made. */
  readonly statements: string[]
  /** How many transactions were opened, per Organization. */
  readonly transactions: string[]
  /** The statement texts that ran inside each transaction, in order, so a test can see what shared one. */
  readonly transactionStatements: string[][]
}

const HEX = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('hex')

/** Postgres's text form of a timestamptz at the given millisecond, with microseconds. */
function pgTimestamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 23).replace('T', ' ').replace('Z', '')}000+00`
}

const infinity = 'infinity'

/** How long after a delete the `cleanup_pending` hint is due (the db library's rule: five minutes). */

/** The columns a document keeps for good; the table's trigger refuses any update that changes one. */
const IDENTITY_COLUMNS = [
  'id',
  'organization_id',
  'name',
  'content_hash',
  'size_bytes',
  'declared_type',
  'detected_type',
  'uploaded_by',
  'object_key',
  'created_at',
] as const satisfies readonly (keyof MemoryDocumentRow)[]

/**
 * A stand-in for the Postgres database that runs the db library's statements by their text and
 * does what their documentation says. It exists so the document routes can be tested without
 * Docker; it is not a second source of truth: the integration suite runs the real statements. A
 * transaction is a copy of the state that replaces it on commit and is dropped when `fn` throws,
 * and transactions run one at a time (the quota lock's effect). A statement it does not know
 * throws, so a route cannot quietly use one the double does not model.
 */
export function createMemoryPlaybookDatabase(options: { clock: Clock }): MemoryPlaybookDatabase {
  let committed: State = {
    documents: [],
    jobs: [],
    keys: [],
    settings: [],
    consumed: [],
    usage: new Set(),
  }
  const failures: { statement: string; error: Error; once: boolean }[] = []
  const commitFailures: { error: Error; applied: boolean }[] = []
  const transactions: string[] = []
  const transactionStatements: string[][] = []
  const discoveries: { kind: string; after: string }[] = []
  const statements: string[] = []
  let queue: Promise<unknown> = Promise.resolve()
  const now = () => options.clock.now().getTime()

  const rows = (list: readonly unknown[]): Result => ({
    rows: list as Record<string, unknown>[],
    rowCount: list.length,
  })
  const none: Result = { rows: [], rowCount: 0 }
  const batch = (value: unknown, max: number) =>
    Math.min(Math.max(typeof value === 'number' ? value : 1, 1), max)

  function runner(state: State, scopeOrganization: string): Run {
    const own = (organization: unknown) => organization === scopeOrganization
    const documentsOf = (organization: unknown) =>
      state.documents.filter((d) => own(organization) && d.organization_id === organization)
    const find = (organization: unknown, id: unknown) =>
      documentsOf(organization).find((d) => d.id === id)
    const touch = (d: MemoryDocumentRow) => {
      d.updated_at = now()
    }
    /** Cancels the document's queued and running jobs; a delete keeps a running job's lease as the fence. */
    const cancelJobs = (organization: string, id: string, deleting = false) => {
      for (const job of state.jobs) {
        if (
          job.organization_id === organization &&
          job.document_id === id &&
          (job.state === 'queued' || job.state === 'running')
        ) {
          if (deleting && job.state === 'queued') {
            job.next_attempt_at = now()
          }
          job.state = 'cancelled'
          job.claim_token = null
        }
      }
    }
    const queueJob = (organization: string, id: string, jobId: string, epoch: number) => {
      state.jobs.push({
        id: jobId,
        organization_id: organization,
        document_id: id,
        epoch,
        state: 'queued',
        step: 'parse',
        attempts: 0,
        next_attempt_at: now(),
        claim_token: null,
        artifact_key: null,
        page_count: null,
        chunk_count: null,
        chunks_done: 0,
        failure_reason: null,
      })
    }
    const usage = (organization: string) => {
      const mine = state.documents.filter((d) => d.organization_id === organization)
      return { count: mine.length, bytes: mine.reduce((sum, d) => sum + d.size_bytes, 0) }
    }
    const view = (d: MemoryDocumentRow) => ({
      id: d.id,
      name: d.name,
      state: d.state,
      size_bytes: String(d.size_bytes),
      declared_type: d.declared_type,
      detected_type: d.detected_type,
      uploaded_by: d.uploaded_by,
      failure_reason: d.failure_reason,
      epoch: d.epoch,
      deletion_seq: d.deletion_seq,
      deleted_at: d.deleted_at === null ? null : pgTimestamp(d.deleted_at),
      deleted_by: d.deleted_by,
      purge_due_at: d.purge_due_at === null ? null : pgTimestamp(d.purge_due_at),
      purge_started_at: d.purge_started_at === null ? null : pgTimestamp(d.purge_started_at),
      page_count: d.page_count,
      created_at: pgTimestamp(d.created_at),
      updated_at: pgTimestamp(d.updated_at),
      not_restorable:
        d.state === 'deleted' &&
        ((d.purge_due_at ?? 0) <= now() ||
          d.purge_started_at !== null ||
          d.restore_barred_at !== null),
    })
    const restore = (params: readonly unknown[], checkDue: boolean): Result => {
      const [organization, id, jobId] = params as [string, string, string]
      const d = find(organization, id)
      if (
        d?.state === 'deleted' &&
        d.purge_started_at === null &&
        d.restore_barred_at === null &&
        (!checkDue || (d.purge_due_at ?? 0) > now())
      ) {
        cancelJobs(organization, id)
        d.state = 'processing'
        d.epoch += 1
        d.deleted_at = d.deleted_by = d.purge_due_at = null
        touch(d)
        queueJob(organization, id, jobId, d.epoch)
        return rows([
          { id, state: 'processing', epoch: d.epoch, deletion_seq: d.deletion_seq, changed: true },
        ])
      }
      if (d !== undefined && d.state !== 'deleted') {
        return rows([
          { id, state: d.state, epoch: d.epoch, deletion_seq: d.deletion_seq, changed: false },
        ])
      }
      return none
    }

    const holder = (organization: string, jobId: string, token: string) =>
      state.jobs.find(
        (j) =>
          own(organization) &&
          j.organization_id === organization &&
          j.id === jobId &&
          j.claim_token === token &&
          j.state === 'running'
      )
    const documentLive = (organization: string, job: MemoryJobRow) => {
      const d = find(organization, job.document_id)
      return (
        d !== undefined && ['uploaded', 'processing'].includes(d.state) && d.epoch === job.epoch
      )
    }
    const settingsView = (row: MemorySettingsRow) => ({
      embedding_model: row.embedding_model,
      embedding_dimension: row.embedding_dimension,
      vectors_written_at:
        row.vectors_written_at === null ? null : pgTimestamp(row.vectors_written_at),
    })

    return async (text, params) => {
      statements.push(text)
      const injected = failures.find((f) => f.statement === text)
      if (injected !== undefined) {
        if (injected.once) {
          failures.splice(failures.indexOf(injected), 1)
        }
        throw injected.error
      }
      switch (text) {
        case QUOTA_LOCK:
          return rows([{ locked: true }])
        case QUOTA_USAGE: {
          const [organization] = params as [string]
          if (!own(organization) || !state.usage.has(organization)) {
            return none
          }
          const u = usage(organization)
          return rows([{ document_count: String(u.count), byte_count: String(u.bytes) }])
        }
        case DOCUMENT_INSERT: {
          const [
            organization,
            id,
            name,
            hash,
            size,
            declared,
            detected,
            by,
            objectKey,
            jobId,
            maxDocuments,
            maxBytes,
          ] = params as [
            string,
            string,
            string,
            Buffer,
            number,
            string,
            string,
            string,
            string,
            string,
            number,
            number,
          ]
          const u = usage(organization)
          const hex = HEX(hash)
          const clash = state.documents.some(
            (d) =>
              d.organization_id === organization &&
              d.content_hash === hex &&
              d.purge_started_at === null &&
              d.restore_barred_at === null
          )
          if (!own(organization) || u.count >= maxDocuments || u.bytes + size > maxBytes || clash) {
            return none
          }
          const at = now()
          state.documents.push({
            id,
            organization_id: organization,
            name,
            content_hash: hex,
            size_bytes: Number(size),
            declared_type: declared,
            detected_type: detected,
            uploaded_by: by,
            object_key: objectKey,
            state: 'uploaded',
            failure_reason: null,
            epoch: 0,
            deletion_seq: 0,
            deleted_at: null,
            deleted_by: null,
            purge_due_at: null,
            purge_started_at: null,
            page_count: null,
            restore_barred_at: null,
            vectors_removed_seq: null,
            purge_attempts: 0,
            purge_lease_until: null,
            created_at: at,
            updated_at: at,
          })
          state.usage.add(organization)
          queueJob(organization, id, jobId, 0)
          return rows([{ id, epoch: 0 }])
        }
        case DOCUMENT_BY_HASH: {
          const [organization, hash] = params as [string, Buffer]
          const d = documentsOf(organization).find(
            (x) =>
              x.content_hash === HEX(hash) &&
              x.purge_started_at === null &&
              x.restore_barred_at === null
          )
          return d === undefined
            ? none
            : rows([{ id: d.id, state: d.state, epoch: d.epoch, deletion_seq: d.deletion_seq }])
        }
        case DOCUMENT_GET: {
          const [organization, id] = params as [string, string]
          const d = find(organization, id)
          return d === undefined ? none : rows([view(d)])
        }
        case DOCUMENT_LIST_FILTERED: {
          const [organization, createdAfter, idAfter, size, wanted] = params as [
            string,
            string,
            string,
            number | null,
            string | null,
          ]
          // Null is every document that is not deleted; a state is that state; anything else is nothing.
          const page = documentsOf(organization)
            .filter((d) => (wanted === null ? d.state !== 'deleted' : d.state === wanted))
            .map((d) => ({ d, created: pgTimestamp(d.created_at) }))
            .filter(
              ({ d, created }) =>
                createdAfter === infinity ||
                created < createdAfter ||
                (created === createdAfter && d.id < idAfter)
            )
            .sort((a, b) =>
              a.created === b.created ? (a.d.id < b.d.id ? 1 : -1) : a.created < b.created ? 1 : -1
            )
            .slice(0, batch(size, DOCUMENT_LIST_MAX_PAGE))
          return rows(page.map(({ d }) => view(d)))
        }
        case DOCUMENT_SOFT_DELETE: {
          const [organization, id, by, retentionMs] = params as [string, string, string, number]
          const d = find(organization, id)
          if (d === undefined) {
            return none
          }
          if (d.state === 'deleted') {
            return rows([
              {
                id,
                state: 'deleted',
                deletion_seq: d.deletion_seq,
                purge_due_at: pgTimestamp(d.purge_due_at ?? 0),
                changed: false,
              },
            ])
          }
          cancelJobs(organization, id, true)
          d.state = 'deleted'
          d.epoch += 1
          d.deletion_seq += 1
          d.deleted_at = now()
          d.deleted_by = by
          d.purge_due_at = now() + Math.max(retentionMs, DOCUMENT_MIN_RETENTION_MS)
          d.failure_reason = null
          touch(d)
          return rows([
            {
              id,
              state: 'deleted',
              deletion_seq: d.deletion_seq,
              purge_due_at: pgTimestamp(d.purge_due_at),
              changed: true,
            },
          ])
        }
        case DOCUMENT_RESTORE:
          return restore(params, true)
        case DOCUMENT_RESTORE_FOR_UPLOAD:
          return restore(params, false)
        case DOCUMENT_REQUEUE: {
          const [organization, id, jobId] = params as [string, string, string]
          const d = find(organization, id)
          if (d?.state === 'failed') {
            cancelJobs(organization, id)
            d.state = 'uploaded'
            d.failure_reason = null
            touch(d)
            queueJob(organization, id, jobId, d.epoch)
            return rows([
              {
                id,
                state: 'uploaded',
                epoch: d.epoch,
                deletion_seq: d.deletion_seq,
                changed: true,
              },
            ])
          }
          if (d !== undefined && ['uploaded', 'processing', 'ready'].includes(d.state)) {
            return rows([
              { id, state: d.state, epoch: d.epoch, deletion_seq: d.deletion_seq, changed: false },
            ])
          }
          return none
        }
        case DOCUMENT_ERASE_BATCH: {
          const [organization, size, actor] = params as [string, number, string]
          const taken = documentsOf(organization)
            .filter((d) => d.restore_barred_at === null)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, batch(size, PLAYBOOK_MAX_BATCH))
          const at = now()
          return rows(
            taken.map((d) => {
              const before = d.deletion_seq
              cancelJobs(organization, d.id, true)
              if (d.state !== 'deleted') {
                d.state = 'deleted'
                d.epoch += 1
                d.deletion_seq += 1
                d.deleted_at = at
                d.deleted_by = actor
              }
              d.purge_due_at = Math.min(d.purge_due_at ?? at, at)
              d.restore_barred_at = at
              d.failure_reason = null
              touch(d)
              return {
                id: d.id,
                epoch: d.epoch,
                deletion_seq: d.deletion_seq,
                changed: d.deletion_seq !== before,
              }
            })
          )
        }
        case ORGANIZATION_REMOVE_REST: {
          const [organization, keepRoute] = params as [string, string]
          if (!own(organization) || documentsOf(organization).length > 0) {
            return rows([{ removed: false }])
          }
          state.usage.delete(organization)
          state.settings = state.settings.filter((x) => x.organization_id !== organization)
          state.consumed = state.consumed.filter((x) => x.organization_id !== organization)
          state.keys = state.keys.filter(
            (k) => k.organization_id !== organization || k.route === keepRoute
          )
          return rows([{ removed: true }])
        }
        case ORGANIZATION_REMOVAL_STATUS: {
          const [organization] = params as [string]
          if (!own(organization)) {
            return none
          }
          const noDocuments = documentsOf(organization).length === 0
          const noUsage = !state.usage.has(organization)
          const noSettings = !state.settings.some((x) => x.organization_id === organization)
          const noMessages = !state.consumed.some((x) => x.organization_id === organization)
          return rows([
            {
              no_documents: noDocuments,
              no_settings: noSettings,
              no_usage: noUsage,
              no_messages: noMessages,
              removed: noDocuments && noSettings && noUsage && noMessages,
            },
          ])
        }
        case IDEMPOTENCY_BEGIN: {
          const [organization, user, route, key, hash] = params as [
            string,
            string,
            string,
            string,
            Buffer,
          ]
          const exists = state.keys.some(
            (k) =>
              k.organization_id === organization &&
              k.user_id === user &&
              k.route === route &&
              k.key === key
          )
          if (!own(organization) || exists) {
            return none
          }
          state.keys.push({
            organization_id: organization,
            user_id: user,
            route,
            key,
            request_hash: HEX(hash),
            status: null,
            response: null,
            created_at: now(),
          })
          return rows([{ key }])
        }
        case IDEMPOTENCY_LOOKUP: {
          const [organization, user, route, key] = params as [string, string, string, string]
          const k = state.keys.find(
            (x) =>
              own(organization) &&
              x.organization_id === organization &&
              x.user_id === user &&
              x.route === route &&
              x.key === key
          )
          return k === undefined
            ? none
            : rows([
                {
                  request_hash: Buffer.from(k.request_hash, 'hex'),
                  status: k.status,
                  response: k.response,
                  created_at: pgTimestamp(now()),
                },
              ])
        }
        case IDEMPOTENCY_COMPLETE: {
          const [organization, user, route, key, status, response] = params as [
            string,
            string,
            string,
            string,
            number,
            string,
          ]
          const k = state.keys.find(
            (x) =>
              x.organization_id === organization &&
              x.user_id === user &&
              x.route === route &&
              x.key === key &&
              x.status === null
          )
          if (k === undefined) {
            return none
          }
          k.status = status
          k.response = typeof response === 'string' ? JSON.parse(response) : response
          return rows([{ key }])
        }
        case DOCUMENT_CLEANUP_BEGIN: {
          const [organization, id, seq] = params as [string, string, number]
          const d = find(organization, id)
          if (d?.state !== 'deleted' || d.deletion_seq !== Number(seq)) {
            return none
          }
          const blocked = state.jobs.some(
            (j) =>
              j.organization_id === organization &&
              j.document_id === id &&
              (j.state === 'cancelled' || j.state === 'running') &&
              j.next_attempt_at > now()
          )
          return rows([{ id, epoch: d.epoch, clear: !blocked }])
        }
        case DOCUMENT_CLEANUP_DONE: {
          const [organization, id, seq] = params as [string, string, number]
          const d = find(organization, id)
          if (d?.state !== 'deleted' || d.deletion_seq !== Number(seq)) {
            return none
          }
          d.vectors_removed_seq = Number(seq)
          touch(d)
          return rows([{ id }])
        }
        case DOCUMENT_PURGE_CLAIM: {
          const [organization, size, leaseMs] = params as [string, number, number]
          const due = documentsOf(organization)
            .filter(
              (d) =>
                d.state === 'deleted' &&
                (d.purge_due_at ?? Number.POSITIVE_INFINITY) <= now() &&
                d.purge_attempts < DOCUMENT_PURGE_MAX_ATTEMPTS &&
                (d.purge_lease_until === null || d.purge_lease_until <= now())
            )
            .sort((a, b) => (a.purge_due_at ?? 0) - (b.purge_due_at ?? 0))
            .slice(0, batch(size, PLAYBOOK_MAX_BATCH))
          return rows(
            due.map((d) => {
              d.purge_started_at ??= now()
              d.purge_attempts += 1
              d.purge_lease_until = now() + Math.max(Number(leaseMs), PLAYBOOK_MIN_LEASE_MS)
              touch(d)
              return {
                id: d.id,
                object_key: d.object_key,
                size_bytes: String(d.size_bytes),
                deletion_seq: d.deletion_seq,
                vectors_removed_seq: d.vectors_removed_seq,
                purge_attempts: d.purge_attempts,
              }
            })
          )
        }
        case DOCUMENT_PURGE_COMPLETE: {
          const [organization, id] = params as [string, string]
          const d = find(organization, id)
          const running = state.jobs.some(
            (j) =>
              j.organization_id === organization &&
              j.document_id === id &&
              j.state === 'running' &&
              j.next_attempt_at > now()
          )
          if (
            d?.state !== 'deleted' ||
            d.purge_started_at === null ||
            d.vectors_removed_seq !== d.deletion_seq ||
            running
          ) {
            return none
          }
          state.documents = state.documents.filter(
            (x) => !(x.organization_id === organization && x.id === id)
          )
          state.jobs = state.jobs.filter(
            (j) => !(j.organization_id === organization && j.document_id === id)
          )
          return rows([{ id, size_bytes: String(d.size_bytes) }])
        }
        case DOCUMENT_LIST_SPENT_PURGES: {
          const [organization, after, size] = params as [string, string, number]
          const spent = documentsOf(organization)
            .filter(
              (d) =>
                d.state === 'deleted' &&
                d.purge_attempts >= DOCUMENT_PURGE_MAX_ATTEMPTS &&
                d.id > after
            )
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, batch(size, DOCUMENT_LIST_MAX_PAGE))
          return rows(
            spent.map((d) => ({
              id: d.id,
              name: d.name,
              size_bytes: String(d.size_bytes),
              object_key: d.object_key,
              deletion_seq: d.deletion_seq,
              vectors_removed_seq: d.vectors_removed_seq,
              deleted_at: pgTimestamp(d.deleted_at ?? 0),
              purge_due_at: pgTimestamp(d.purge_due_at ?? 0),
              purge_started_at:
                d.purge_started_at === null ? null : pgTimestamp(d.purge_started_at),
              purge_lease_until:
                d.purge_lease_until === null ? null : pgTimestamp(d.purge_lease_until),
              purge_attempts: d.purge_attempts,
              restore_barred_at:
                d.restore_barred_at === null ? null : pgTimestamp(d.restore_barred_at),
            }))
          )
        }
        case INGESTION_JOB_CLAIM: {
          const [organization, size, leaseMs, onlyJob] = params as [
            string,
            number,
            number,
            string | null,
          ]
          const due = state.jobs
            .filter(
              (j) =>
                own(organization) &&
                j.organization_id === organization &&
                (j.state === 'queued' || j.state === 'running') &&
                j.attempts < INGESTION_JOB_MAX_ATTEMPTS &&
                j.next_attempt_at <= now() &&
                (onlyJob === null || j.id === onlyJob)
            )
            .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
            .slice(0, batch(size, PLAYBOOK_MAX_BATCH))
          let cancelled = 0
          const claimed: MemoryJobRow[] = []
          for (const job of due) {
            const d = find(organization, job.document_id)
            const live =
              d !== undefined &&
              ['uploaded', 'processing'].includes(d.state) &&
              d.epoch === job.epoch
            if (!live) {
              job.state = 'cancelled'
              job.claim_token = null
              cancelled++
              continue
            }
            job.state = 'running'
            job.attempts += 1
            job.claim_token = crypto.randomUUID()
            job.next_attempt_at = now() + Math.max(Number(leaseMs), PLAYBOOK_MIN_LEASE_MS)
            d.state = 'processing'
            touch(d)
            claimed.push(job)
          }
          if (claimed.length === 0) {
            return cancelled > 0
              ? rows([
                  {
                    id: null,
                    document_id: null,
                    epoch: null,
                    step: null,
                    attempts: null,
                    claim_token: null,
                    artifact_key: null,
                    page_count: null,
                    chunk_count: null,
                    chunks_done: null,
                    cancelled,
                    lost: 0,
                  },
                ])
              : none
          }
          return rows(
            claimed.map((j) => ({
              id: j.id,
              document_id: j.document_id,
              epoch: j.epoch,
              step: j.step,
              attempts: j.attempts,
              claim_token: j.claim_token,
              artifact_key: j.artifact_key,
              page_count: j.page_count,
              chunk_count: j.chunk_count,
              chunks_done: j.chunks_done,
              cancelled,
              lost: 0,
            }))
          )
        }
        case INGESTION_JOB_HEARTBEAT:
        case INGESTION_JOB_ADVANCE: {
          const advancing = text === INGESTION_JOB_ADVANCE
          const [organization, jobId, token] = params as [string, string, string]
          const job = holder(organization, jobId, token)
          if (job === undefined || !documentLive(organization, job)) {
            return none
          }
          if (!advancing) {
            const [, , , leaseMs] = params as [string, string, string, number]
            job.next_attempt_at = now() + Math.max(Number(leaseMs), PLAYBOOK_MIN_LEASE_MS)
            return rows([{ id: jobId }])
          }
          const [, , , step, artifact, pages, chunks, done, leaseMs] = params as [
            string,
            string,
            string,
            (typeof INGESTION_STEPS)[number],
            string | null,
            number | null,
            number | null,
            number | null,
            number,
          ]
          if (INGESTION_STEPS.indexOf(step) < INGESTION_STEPS.indexOf(job.step)) {
            return none
          }
          const nextChunks = chunks ?? job.chunk_count
          const nextDone = done ?? job.chunks_done
          if (
            (pages !== null && (pages < 1 || pages > DOCUMENT_MAX_PAGE_COUNT)) ||
            (chunks !== null && (chunks < 0 || chunks > INGESTION_MAX_CHUNKS)) ||
            nextDone > (nextChunks ?? 0)
          ) {
            throw postgresError('23514', 'ingestion_jobs_counts_bounds')
          }
          job.step = step
          job.artifact_key = artifact ?? job.artifact_key
          job.page_count = pages ?? job.page_count
          job.chunk_count = nextChunks
          job.chunks_done = nextDone
          job.next_attempt_at = now() + Math.max(Number(leaseMs), PLAYBOOK_MIN_LEASE_MS)
          return rows([{ id: jobId, step, chunks_done: job.chunks_done }])
        }
        case INGESTION_JOB_RETRY: {
          const [organization, jobId, token, delayMs] = params as [string, string, string, number]
          const job = holder(organization, jobId, token)
          if (job === undefined) {
            return none
          }
          job.state = 'queued'
          job.claim_token = null
          job.next_attempt_at =
            now() + Math.min(Math.max(Number(delayMs) || 0, 0), INGESTION_MAX_RETRY_DELAY_MS)
          return rows([{ id: jobId, attempts: job.attempts }])
        }
        case INGESTION_JOB_COMPLETE: {
          const [organization, jobId, token] = params as [string, string, string]
          const job = holder(organization, jobId, token)
          const d = job === undefined ? undefined : find(organization, job.document_id)
          if (job === undefined || d?.state !== 'processing' || d.epoch !== job.epoch) {
            return none
          }
          job.state = 'succeeded'
          job.claim_token = null
          d.state = 'ready'
          d.page_count = job.page_count ?? d.page_count
          touch(d)
          return rows([{ document_id: d.id }])
        }
        case INGESTION_JOB_FAIL: {
          const [organization, jobId, token, reason] = params as [string, string, string, string]
          const job = holder(organization, jobId, token)
          if (job === undefined || !documentLive(organization, job)) {
            return none
          }
          if (!(DOCUMENT_FAILURE_REASONS as readonly string[]).includes(reason)) {
            throw postgresError('23514', 'ingestion_jobs_failure_reason_known')
          }
          const d = find(organization, job.document_id)
          job.state = 'failed'
          job.failure_reason = reason
          job.claim_token = null
          if (d !== undefined) {
            d.state = 'failed'
            d.failure_reason = reason
            d.page_count = job.page_count ?? d.page_count
            touch(d)
          }
          return rows([{ document_id: job.document_id }])
        }
        case INGESTION_JOB_GIVE_UP_SPENT: {
          const [organization, size] = params as [string, number]
          const spent = state.jobs
            .filter(
              (j) =>
                own(organization) &&
                j.organization_id === organization &&
                (j.state === 'queued' || j.state === 'running') &&
                j.attempts >= INGESTION_JOB_MAX_ATTEMPTS &&
                j.next_attempt_at <= now()
            )
            .slice(0, batch(size, PLAYBOOK_MAX_BATCH))
          return rows(
            spent.map((job) => {
              job.state = 'failed'
              job.failure_reason = 'processing_failed'
              job.claim_token = null
              const d = find(organization, job.document_id)
              if (d !== undefined && documentLive(organization, job)) {
                d.state = 'failed'
                d.failure_reason = 'processing_failed'
                touch(d)
              }
              return { document_id: job.document_id }
            })
          )
        }
        case CONSUMED_CLAIM: {
          const [consumer, organization, messageId, token, leaseMs] = params as [
            string,
            string,
            string,
            string,
            number,
          ]
          if (!own(organization)) {
            return none
          }
          const existing = state.consumed.find(
            (c) =>
              c.consumer === consumer &&
              c.organization_id === organization &&
              c.message_id === messageId
          )
          const lease = now() + Math.max(Number(leaseMs), PLAYBOOK_MIN_LEASE_MS)
          if (existing === undefined) {
            state.consumed.push({
              consumer,
              organization_id: organization,
              message_id: messageId,
              state: 'claimed',
              claim_token: token,
              lease_expires_at: lease,
              completed_at: null,
            })
            return rows([{ claim_token: token }])
          }
          if (existing.state === 'claimed' && (existing.lease_expires_at ?? 0) <= now()) {
            existing.claim_token = token
            existing.lease_expires_at = lease
            return rows([{ claim_token: token }])
          }
          return none
        }
        case CONSUMED_LOOKUP: {
          const [consumer, organization, messageId] = params as [string, string, string]
          const c = state.consumed.find(
            (x) =>
              own(organization) &&
              x.consumer === consumer &&
              x.organization_id === organization &&
              x.message_id === messageId
          )
          return c === undefined
            ? none
            : rows([
                {
                  state: c.state,
                  retry_after_seconds:
                    c.state === 'claimed'
                      ? Math.max(1, Math.ceil(((c.lease_expires_at ?? 0) - now()) / 1000))
                      : null,
                },
              ])
        }
        case CONSUMED_RENEW:
        case CONSUMED_COMPLETE:
        case CONSUMED_RELEASE: {
          const [consumer, organization, messageId, token, leaseMs] = params as [
            string,
            string,
            string,
            string,
            number,
          ]
          const c = state.consumed.find(
            (x) =>
              own(organization) &&
              x.consumer === consumer &&
              x.organization_id === organization &&
              x.message_id === messageId &&
              x.claim_token === token &&
              x.state === 'claimed'
          )
          if (c === undefined) {
            return none
          }
          if (text === CONSUMED_RELEASE) {
            state.consumed.splice(state.consumed.indexOf(c), 1)
            return { rows: [], rowCount: 1 }
          }
          if (text === CONSUMED_RENEW) {
            if ((c.lease_expires_at ?? 0) <= now()) {
              return none
            }
            c.lease_expires_at = now() + Math.max(Number(leaseMs), PLAYBOOK_MIN_LEASE_MS)
          } else {
            c.state = 'done'
            c.completed_at = now()
            c.lease_expires_at = null
          }
          return rows([{ claim_token: token }])
        }
        case CONSUMED_PURGE: {
          const [organization, before, size] = params as [string, string, number]
          if (!own(organization)) {
            return none
          }
          const cutoff = new Date(before).getTime()
          const gone = state.consumed
            .filter(
              (c) =>
                c.organization_id === organization &&
                ((c.state === 'done' && (c.completed_at ?? 0) < cutoff) ||
                  (c.state === 'claimed' && (c.lease_expires_at ?? 0) <= now()))
            )
            .slice(0, batch(size, PLAYBOOK_MAX_BATCH))
          state.consumed = state.consumed.filter((c) => !gone.includes(c))
          return { rows: [], rowCount: gone.length }
        }
        case INDEX_SETTINGS_UPSERT: {
          const [organization, model, dimension] = params as [string, string, number]
          if (!own(organization)) {
            return none
          }
          const row = state.settings.find((x) => x.organization_id === organization)
          if (row === undefined) {
            const created: MemorySettingsRow = {
              organization_id: organization,
              embedding_model: model,
              embedding_dimension: Number(dimension),
              vectors_written_at: null,
            }
            state.settings.push(created)
            return rows([settingsView(created)])
          }
          if (
            row.vectors_written_at === null ||
            (row.embedding_model === model && row.embedding_dimension === Number(dimension))
          ) {
            row.embedding_model = model
            row.embedding_dimension = Number(dimension)
            return rows([settingsView(row)])
          }
          return none
        }
        case INDEX_VECTORS_MARK: {
          const [organization] = params as [string]
          const row = state.settings.find(
            (x) => own(organization) && x.organization_id === organization
          )
          if (row === undefined) {
            return none
          }
          row.vectors_written_at ??= now()
          return rows([
            { embedding_model: row.embedding_model, embedding_dimension: row.embedding_dimension },
          ])
        }
        case IDEMPOTENCY_PURGE: {
          const [organization, ageMs, size] = params as [string, number, number]
          const age = Math.max(Number(ageMs) || 0, IDEMPOTENCY_MIN_PURGE_AGE_MS)
          const gone = state.keys
            .filter(
              (k) =>
                own(organization) &&
                k.organization_id === organization &&
                k.created_at < now() - age
            )
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, batch(size, PLAYBOOK_MAX_BATCH))
          state.keys = state.keys.filter((k) => !gone.includes(k))
          return { rows: [], rowCount: gone.length }
        }
        case ORGANIZATIONS_WITH_WORK:
          // Postgres raises this inside an Organization's scope; the unscoped path is `discover`.
          throw postgresError(
            '42501',
            'organizations_with_work cannot run inside an Organization scope'
          )
        default:
          if (text.startsWith('set local lock_timeout')) {
            return none
          }
          throw new Error(`the database double does not model this statement: ${text.slice(0, 60)}`)
      }
    }
  }

  const discover: Discover = async (kind, after, size) => {
    discoveries.push({ kind, after })
    // An unscoped call sees every Organization; the real function verifies each hint in its own scope.
    const organizations = new Set<string>()
    const documentsDue = (predicate: (d: MemoryDocumentRow) => boolean) => {
      for (const d of committed.documents.filter(predicate)) {
        organizations.add(d.organization_id)
      }
    }
    switch (kind) {
      case 'purge_due':
        documentsDue(
          (d) =>
            d.state === 'deleted' &&
            (d.purge_due_at ?? Number.POSITIVE_INFINITY) <= now() &&
            d.purge_attempts < DOCUMENT_PURGE_MAX_ATTEMPTS &&
            (d.purge_lease_until === null || d.purge_lease_until <= now())
        )
        break
      case 'purge_spent':
        documentsDue(
          (d) => d.state === 'deleted' && d.purge_attempts >= DOCUMENT_PURGE_MAX_ATTEMPTS
        )
        break
      case 'cleanup_pending':
        documentsDue(
          (d) =>
            d.state === 'deleted' &&
            (d.vectors_removed_seq === null || d.vectors_removed_seq < d.deletion_seq) &&
            (d.deleted_at ?? 0) + CLEANUP_PENDING_AFTER_MS <= now()
        )
        break
      case 'jobs_due':
        for (const j of committed.jobs) {
          if ((j.state === 'queued' || j.state === 'running') && j.next_attempt_at <= now()) {
            organizations.add(j.organization_id)
          }
        }
        break
      case 'consumed_purge':
        for (const c of committed.consumed) {
          if (
            (c.state === 'done' && (c.completed_at ?? 0) + CONSUMED_PURGE_AGE_MS <= now()) ||
            (c.state === 'claimed' && (c.lease_expires_at ?? 0) <= now())
          ) {
            organizations.add(c.organization_id)
          }
        }
        break
      case 'idempotency_purge':
        for (const k of committed.keys) {
          if (k.created_at + IDEMPOTENCY_PURGE_AGE_MS <= now()) {
            organizations.add(k.organization_id)
          }
        }
        break
    }
    const visited = [...organizations].sort().filter((id) => id > after)
    const page = visited.slice(0, batch(size, PLAYBOOK_MAX_BATCH))
    const last = page.at(-1)
    return last === undefined ? [] : page.map((id) => ({ organization_id: id, resume_after: last }))
  }

  const scope: InScope = (organizationId, fn) => {
    const run = async () => {
      transactions.push(organizationId)
      const draft: State = {
        documents: structuredClone(committed.documents),
        jobs: structuredClone(committed.jobs),
        keys: structuredClone(committed.keys),
        settings: structuredClone(committed.settings),
        consumed: structuredClone(committed.consumed),
        usage: new Set(committed.usage),
      }
      const inside: string[] = []
      transactionStatements.push(inside)
      const inner = runner(draft, organizationId)
      const result = await fn(async (text, params) => {
        inside.push(text)
        return inner(text, params)
      })
      const commitFailure = commitFailures.shift()
      if (commitFailure !== undefined) {
        if (commitFailure.applied) {
          committed = draft
        }
        throw commitFailure.error
      }
      committed = draft
      return result
    }
    const turn = queue.then(run, run)
    queue = turn.catch(() => undefined)
    return turn
  }

  return {
    scope,
    discover,
    discoveries,
    settings: (organizationId) =>
      committed.settings.find((x) => x.organization_id === organizationId),
    consumed: (organizationId) =>
      committed.consumed.filter((c) => c.organization_id === organizationId),
    transactionStatements,
    documents: (organizationId) =>
      committed.documents.filter((d) => d.organization_id === organizationId),
    jobs: (organizationId) => committed.jobs.filter((j) => j.organization_id === organizationId),
    keys: (organizationId) => committed.keys.filter((k) => k.organization_id === organizationId),
    seed: (row) => {
      const at = now()
      committed.documents.push({
        name: 'seed.pdf',
        content_hash: HEX(crypto.getRandomValues(new Uint8Array(32))),
        size_bytes: 10,
        declared_type: 'application/pdf',
        detected_type: 'pdf',
        uploaded_by: `usr_${'0'.repeat(31)}1`,
        object_key: `documents/${row.id}/original.pdf`,
        state: 'ready',
        failure_reason: null,
        epoch: 0,
        deletion_seq: 0,
        deleted_at: null,
        deleted_by: null,
        purge_due_at: null,
        purge_started_at: null,
        page_count: null,
        restore_barred_at: null,
        vectors_removed_seq: null,
        purge_attempts: 0,
        purge_lease_until: null,
        created_at: at,
        updated_at: at,
        ...row,
      })
      committed.usage.add(row.organization_id)
    },
    seedKeyInFlight: (key) => {
      committed.keys.push({ ...key, status: null, response: null, created_at: now() })
    },
    update: (organizationId, id, change) => {
      const d = committed.documents.find((x) => x.organization_id === organizationId && x.id === id)
      if (d === undefined) {
        throw new Error('no such seeded document')
      }
      const next = { ...d, ...change }
      // What the table's trigger and checks refuse, so a test cannot arrange a state Postgres forbids.
      for (const column of IDENTITY_COLUMNS) {
        if (next[column] !== d[column]) {
          throw postgresError('23514', `playbook.document_identity: ${column} never changes`)
        }
      }
      if (next.epoch < d.epoch || next.deletion_seq < d.deletion_seq) {
        throw postgresError(
          '23514',
          'playbook.document_identity: epoch and deletion_seq never go down'
        )
      }
      if ((next.state === 'deleted') !== (next.deleted_at !== null)) {
        throw postgresError('23514', 'documents_deleted_has_times')
      }
      if (
        next.purge_due_at !== null &&
        next.deleted_at !== null &&
        next.purge_due_at < next.deleted_at
      ) {
        throw postgresError('23514', 'documents_purge_due_after_delete')
      }
      if ((next.state === 'failed') !== (next.failure_reason !== null)) {
        throw postgresError('23514', 'documents_failed_has_reason')
      }
      Object.assign(d, change)
    },
    purgeAll: (organizationId) => {
      committed.documents = committed.documents.filter((d) => d.organization_id !== organizationId)
      committed.jobs = committed.jobs.filter((j) => j.organization_id !== organizationId)
    },
    failNext: (statement, error) => void failures.push({ statement, error, once: true }),
    failAlways: (statement, error) => void failures.push({ statement, error, once: false }),
    failNextCommit: (error, options) =>
      void commitFailures.push({ error, applied: options.applied }),
    clearFailures: () => {
      failures.splice(0, failures.length)
      commitFailures.splice(0, commitFailures.length)
    },
    transactions,
    statements,
  }
}
