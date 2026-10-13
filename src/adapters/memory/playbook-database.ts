import {
  DOCUMENT_BY_HASH,
  DOCUMENT_ERASE_BATCH,
  DOCUMENT_GET,
  DOCUMENT_INSERT,
  DOCUMENT_LIST,
  DOCUMENT_LIST_DELETED,
  DOCUMENT_LIST_MAX_PAGE,
  DOCUMENT_MIN_RETENTION_MS,
  DOCUMENT_REQUEUE,
  DOCUMENT_RESTORE,
  DOCUMENT_RESTORE_FOR_UPLOAD,
  DOCUMENT_SOFT_DELETE,
  IDEMPOTENCY_BEGIN,
  IDEMPOTENCY_COMPLETE,
  IDEMPOTENCY_LOOKUP,
  ORGANIZATION_REMOVAL_STATUS,
  ORGANIZATION_REMOVE_REST,
  PLAYBOOK_MAX_BATCH,
  QUOTA_LOCK,
  QUOTA_USAGE,
} from 'tula-closeline-db'
import type { Clock } from 'tula-closeline-kit'
import type { InScope, Result, Run } from '~/adapters/postgres/processed-store'

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
  restore_barred_at: number | null
  created_at: number
  updated_at: number
}

/** One row of `playbook.ingestion_jobs`, as far as the document routes write it. */
export type MemoryJobRow = {
  id: string
  organization_id: string
  document_id: string
  epoch: number
  state: 'queued' | 'cancelled'
}

type KeyRow = {
  organization_id: string
  user_id: string
  route: string
  key: string
  request_hash: string
  status: number | null
  response: unknown
}

type State = {
  documents: MemoryDocumentRow[]
  jobs: MemoryJobRow[]
  keys: KeyRow[]
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
  /** How many transactions were opened, per Organization. */
  readonly transactions: string[]
}

const HEX = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('hex')

/** Postgres's text form of a timestamptz at the given millisecond, with microseconds. */
function pgTimestamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 23).replace('T', ' ').replace('Z', '')}000+00`
}

const infinity = 'infinity'

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
  let committed: State = { documents: [], jobs: [], keys: [], usage: new Set() }
  const failures: { statement: string; error: Error; once: boolean }[] = []
  const commitFailures: { error: Error; applied: boolean }[] = []
  const transactions: string[] = []
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
    const cancelJobs = (organization: string, id: string) => {
      for (const job of state.jobs) {
        if (
          job.organization_id === organization &&
          job.document_id === id &&
          job.state === 'queued'
        ) {
          job.state = 'cancelled'
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

    return async (text, params) => {
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
            restore_barred_at: null,
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
        case DOCUMENT_LIST:
        case DOCUMENT_LIST_DELETED: {
          const [organization, createdAfter, idAfter, size] = params as [
            string,
            string,
            string,
            number,
          ]
          const wantDeleted = text === DOCUMENT_LIST_DELETED
          const page = documentsOf(organization)
            .filter((d) => (d.state === 'deleted') === wantDeleted)
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
          return rows(
            page.map(({ d, created }) => ({
              id: d.id,
              name: d.name,
              state: d.state,
              size_bytes: String(d.size_bytes),
              detected_type: d.detected_type,
              failure_reason: d.failure_reason,
              uploaded_by: d.uploaded_by,
              deletion_seq: d.deletion_seq,
              deleted_at: d.deleted_at === null ? null : pgTimestamp(d.deleted_at),
              purge_due_at: d.purge_due_at === null ? null : pgTimestamp(d.purge_due_at),
              created_at: created,
            }))
          )
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
          cancelJobs(organization, id)
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
              cancelJobs(organization, d.id)
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
          return rows([
            {
              no_documents: noDocuments,
              no_settings: true,
              no_usage: noUsage,
              no_messages: true,
              removed: noDocuments && noUsage,
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
        default:
          if (text.startsWith('set local lock_timeout')) {
            return none
          }
          throw new Error(`the database double does not model this statement: ${text.slice(0, 60)}`)
      }
    }
  }

  const scope: InScope = (organizationId, fn) => {
    const run = async () => {
      transactions.push(organizationId)
      const draft: State = {
        documents: structuredClone(committed.documents),
        jobs: structuredClone(committed.jobs),
        keys: structuredClone(committed.keys),
        usage: new Set(committed.usage),
      }
      const result = await fn(runner(draft, organizationId))
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
        restore_barred_at: null,
        created_at: at,
        updated_at: at,
        ...row,
      })
      committed.usage.add(row.organization_id)
    },
    seedKeyInFlight: (key) => {
      committed.keys.push({ ...key, status: null, response: null })
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
  }
}
