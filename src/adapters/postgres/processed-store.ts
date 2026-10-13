import { type SQL, sql } from 'drizzle-orm'
import {
  CONSUMED_CLAIM,
  CONSUMED_COMPLETE,
  CONSUMED_LOOKUP,
  CONSUMED_PURGE,
  CONSUMED_RELEASE,
  CONSUMED_RENEW,
  type Database,
  withOrganization,
} from 'tula-closeline-db'
import { GLOBAL_SCOPE_ORGANIZATION_ID } from 'tula-closeline-db/schema'
import type { ClaimResult, ConsumedKey, ProcessedStore } from 'tula-closeline-kit'

/** What one statement answered: its rows and the number of rows it changed. */
export type Result = {
  rows: readonly Record<string, unknown>[]
  rowCount: number
}

/** Runs one of the db library's parameterised statements inside the scope it was opened in. */
export type Run = (text: string, params: readonly unknown[]) => Promise<Result>

/**
 * Opens a transaction scoped to one Organization (the tenant-scoped helper) and hands `fn` a
 * {@link Run} for it. Every query of the store goes through this and never through a bare
 * connection.
 */
export type InScope = <T>(organizationId: string, fn: (run: Run) => Promise<T>) => Promise<T>

/** The most times `claim` repeats itself when the record disappears between its two steps. */
export const DEFAULT_MAX_CLAIM_ATTEMPTS = 3

/**
 * Builds a Drizzle statement from one of the db library's `$1 ... $n` texts and its values. The
 * library's statements are plain text with numbered placeholders, which Drizzle's `execute` cannot
 * bind, so each occurrence of `$n` becomes a bound parameter holding the n-th value.
 *
 * @throws Error when a placeholder has no value.
 */
export function statementOf(text: string, params: readonly unknown[]): SQL {
  const chunks: SQL[] = []
  let last = 0
  for (const match of text.matchAll(/\$(\d+)/g)) {
    const index = Number(match[1]) - 1
    if (index < 0 || index >= params.length) {
      throw new Error(`statement placeholder $${index + 1} has no value`)
    }
    chunks.push(sql.raw(text.slice(last, match.index)))
    chunks.push(sql`${params[index]}`)
    last = match.index + match[0].length
  }
  chunks.push(sql.raw(text.slice(last)))
  return sql.join(chunks, sql.raw(''))
}

/** The tenant-scoped helper of the db library, over a database from `createDb`. */
export function scopeOver(db: Database): InScope {
  return (organizationId, fn) =>
    withOrganization(db, organizationId, (tx) =>
      fn(async (text, params) => {
        const result = await tx.execute(statementOf(text, params))
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 }
      })
    )
}

/** Thrown by {@link PostgresProcessedStore.purge}: the Organizations to purge cannot be found yet. */
export class ProcessedStorePurgeUnavailableError extends Error {
  /** Creates the error with the message that names the missing work. */
  constructor() {
    super(
      'ProcessedStore.purge cannot run: every playbook table is under row-level security, so the ' +
        'Organizations that hold old consumed messages cannot be listed until hub issue #53 adds ' +
        'work discovery. Call purgeScope for a known Organization, or for the global scope.'
    )
    this.name = 'ProcessedStorePurgeUnavailableError'
  }
}

/** The kit's {@link ProcessedStore} over `playbook.consumed_message`, plus the part of purge that works. */
export interface PostgresProcessedStore extends ProcessedStore {
  /**
   * Purges one scope (an Organization's, or {@link GLOBAL_SCOPE_ORGANIZATION_ID}): `done` records
   * completed before `before` and lapsed claims, at most `limit` (the database caps it at 500).
   * Returns how many went. This is the building block of the periodic purge.
   */
  purgeScope(organizationId: string, before: Date, limit: number): Promise<number>
}

/** Options of {@link createPostgresProcessedStore}. */
export type PostgresProcessedStoreOptions = {
  scope: InScope
  /** Makes a claim token (a uuid); defaults to `crypto.randomUUID`. */
  newToken?: () => string
  /** How many times `claim` repeats when the record vanishes between its two steps. */
  maxClaimAttempts?: number
}

/** A claim token is a uuid in the table, so only a uuid can be one this store issued. */
const TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The shape the table's checks require of a consumer name and a message id. */
const NAME_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/

/** The shape of an Organization wire id. */
const ORGANIZATION_SHAPE = /^org_[0-9a-f]{32}$/

/**
 * Whether a record could exist for `key` and `token`. A token that is not a uuid, or a key the
 * table's checks would refuse, names no record: `renew`, `complete` and `release` then answer as
 * for a stale token without a query, as the kit's contract says (a database error here would
 * wrongly look like a failure of the store).
 */
function couldExist(key: ConsumedKey, token: string): boolean {
  return TOKEN_SHAPE.test(token) && keyIsValid(key)
}

/** Whether the table could hold a record under `key`. */
function keyIsValid(key: ConsumedKey): boolean {
  return (
    NAME_SHAPE.test(key.consumer) &&
    NAME_SHAPE.test(key.messageId) &&
    (key.organizationId === null || ORGANIZATION_SHAPE.test(key.organizationId))
  )
}

/** Throws a clear error for a key the table cannot hold, naming the part and never its value. */
function assertKey(key: ConsumedKey): void {
  if (!NAME_SHAPE.test(key.consumer)) {
    throw new RangeError('consumer name must be 1 to 128 of letters, digits and _ . : -')
  }
  if (!NAME_SHAPE.test(key.messageId)) {
    throw new RangeError('message id must be 1 to 128 of letters, digits and _ . : -')
  }
  if (key.organizationId !== null && !ORGANIZATION_SHAPE.test(key.organizationId)) {
    throw new RangeError('Organization id must be org_ and 32 lower-case hex digits')
  }
}

/** Throws unless `seconds` is a finite number above zero, and returns it in milliseconds. */
function leaseMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError('lease must be a finite number of seconds above zero')
  }
  return seconds * 1000
}

/** The scope a message is recorded under: its Organization, or the all-zero id for a global message. */
function scopeOf(key: ConsumedKey): string {
  return key.organizationId ?? GLOBAL_SCOPE_ORGANIZATION_ID
}

/** The whole seconds a busy claim reports, at least one. */
function retryAfter(value: unknown): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 1 ? Math.ceil(seconds) : 1
}

/**
 * Creates the Postgres {@link ProcessedStore}. The Organization id goes in as the wire id,
 * unchanged; a global message is recorded under the all-zero id; leases are sent in milliseconds;
 * and the claim is one statement, followed on a miss by a lookup in a transaction of its own
 * (the statement's rows are hidden from a lookup that shares its snapshot), repeated when the
 * lookup finds no row because the record was released or purged in between.
 */
export function createPostgresProcessedStore(
  options: PostgresProcessedStoreOptions
): PostgresProcessedStore {
  const { scope } = options
  const newToken = options.newToken ?? (() => crypto.randomUUID())
  const maxAttempts = options.maxClaimAttempts ?? DEFAULT_MAX_CLAIM_ATTEMPTS

  return {
    async claim(key, leaseSeconds): Promise<ClaimResult> {
      assertKey(key)
      const lease = leaseMs(leaseSeconds)
      const organizationId = scopeOf(key)
      const token = newToken()
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const claimed = await scope(organizationId, (run) =>
          run(CONSUMED_CLAIM, [key.consumer, organizationId, key.messageId, token, lease])
        )
        if (claimed.rows.length > 0) {
          return { status: 'claimed', token }
        }
        const found = await scope(organizationId, (run) =>
          run(CONSUMED_LOOKUP, [key.consumer, organizationId, key.messageId])
        )
        const row = found.rows[0]
        if (row === undefined) {
          continue
        }
        if (row.state === 'done') {
          return { status: 'done' }
        }
        if (row.state === 'claimed') {
          return { status: 'busy', retryAfterSeconds: retryAfter(row.retry_after_seconds) }
        }
        throw new Error('consumed_message holds a state the store does not know')
      }
      throw new Error(`consumed_message record kept vanishing during ${maxAttempts} claim attempts`)
    },

    async renew(key, token, leaseSeconds) {
      const lease = leaseMs(leaseSeconds)
      if (!couldExist(key, token)) {
        return false
      }
      const organizationId = scopeOf(key)
      const result = await scope(organizationId, (run) =>
        run(CONSUMED_RENEW, [key.consumer, organizationId, key.messageId, token, lease])
      )
      return result.rows.length > 0
    },

    async complete(key, token) {
      if (!couldExist(key, token)) {
        return false
      }
      const organizationId = scopeOf(key)
      const result = await scope(organizationId, (run) =>
        run(CONSUMED_COMPLETE, [key.consumer, organizationId, key.messageId, token])
      )
      return result.rows.length > 0
    },

    async release(key, token) {
      if (!couldExist(key, token)) {
        return
      }
      const organizationId = scopeOf(key)
      await scope(organizationId, (run) =>
        run(CONSUMED_RELEASE, [key.consumer, organizationId, key.messageId, token])
      )
    },

    async purgeScope(organizationId, before, limit) {
      if (Number.isNaN(before.getTime())) {
        throw new RangeError('purge cutoff must be a valid date')
      }
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError('purge limit must be a whole number of at least 1')
      }
      const result = await scope(organizationId, (run) =>
        run(CONSUMED_PURGE, [organizationId, before.toISOString(), limit])
      )
      return result.rowCount
    },

    purge(): Promise<number> {
      // Not a quiet partial purge: a run that skipped every Organization would look like success.
      return Promise.reject(new ProcessedStorePurgeUnavailableError())
    },
  }
}
