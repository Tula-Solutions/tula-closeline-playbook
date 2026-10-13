import { createHash } from 'node:crypto'
import { ERRORS } from 'tula-closeline-contract'
import { IDEMPOTENCY_BEGIN, IDEMPOTENCY_COMPLETE, IDEMPOTENCY_LOOKUP } from 'tula-closeline-db'
import type { Run } from '~/adapters/postgres/processed-store'
import { isLockTimeout } from '~/adapters/postgres/retry'
import { domainError, RetryAfterError } from '~/http/domain-error'

/** What a client is told to wait, in seconds, when a key is held or a lock timed out. */
export const RETRY_AFTER_SECONDS = 1

/** The longest a statement of a keyed transaction waits for a lock, so a held key answers fast. */
export const LOCK_TIMEOUT_SQL = "set local lock_timeout = '2000ms'"

/** The request a key belongs to. */
export type KeyedRequest = {
  /** The `Idempotency-Key` header, already validated; absent means the call is not protected. */
  key: string | undefined
  /** The Organization, the user (or the internal-call user) and a fixed route name. */
  organizationId: string
  userId: string
  route: string
  /** SHA-256 of everything the answer depends on besides the caller. */
  requestHash: Buffer
}

/** What reserving a key found. */
export type Reservation =
  | { kind: 'none' }
  | { kind: 'reserved' }
  | { kind: 'replay'; status: number; response: unknown }

/** The canonical text of a value: JSON with every object's keys in code-point order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(',')}}`
}

/** The SHA-256 of the route's name and the canonical form of its request, as the key table stores it. */
export function requestHashOf(route: string, request: unknown): Buffer {
  return createHash('sha256').update(canonicalJson({ route, request })).digest()
}

function inProgress(): RetryAfterError {
  return new RetryAfterError(ERRORS['request.idempotency_in_progress'], RETRY_AFTER_SECONDS, {
    retryAfter: RETRY_AFTER_SECONDS,
  })
}

/**
 * Claims the call's key in the caller's transaction, as the db library describes: the row goes in
 * in flight, the write follows, and {@link completeKey} finishes it in the same transaction, so a
 * row in flight is never committed. The same key with the same request after it completed is a
 * replay; the same key with another request is `request.idempotency_key_reused`; a key another
 * transaction holds (the wait ran into `lock_timeout`, or a row is in flight) is
 * `request.idempotency_in_progress` with `Retry-After`. Take the key before any other lock, so two
 * calls with one key cannot wait on each other.
 */
export async function reserveKey(run: Run, call: KeyedRequest): Promise<Reservation> {
  if (call.key === undefined) {
    return { kind: 'none' }
  }
  const values = [call.organizationId, call.userId, call.route, call.key] as const
  let began: Awaited<ReturnType<Run>>
  try {
    began = await run(IDEMPOTENCY_BEGIN, [...values, call.requestHash])
  } catch (error) {
    throw isLockTimeout(error) ? inProgress() : error
  }
  if (began.rows.length > 0) {
    return { kind: 'reserved' }
  }
  const found = (await run(IDEMPOTENCY_LOOKUP, values)).rows[0]
  if (found === undefined) {
    throw inProgress()
  }
  return replayOf(found, call)
}

/**
 * Reads the stored answer of a key without claiming it: the replay if the same request completed
 * before, `undefined` when the key is new, and the same refusals as {@link reserveKey} for a key
 * used for another request or held by a call in flight.
 */
export async function findKey(
  run: Run,
  call: KeyedRequest
): Promise<Extract<Reservation, { kind: 'replay' }> | undefined> {
  if (call.key === undefined) {
    return undefined
  }
  const found = (
    await run(IDEMPOTENCY_LOOKUP, [call.organizationId, call.userId, call.route, call.key])
  ).rows[0]
  if (found === undefined) {
    return undefined
  }
  return replayOf(found, call)
}

/** The replay a stored key row stands for, or the refusal for a request that differs or is still running. */
function replayOf(
  found: Record<string, unknown>,
  call: KeyedRequest
): Extract<Reservation, { kind: 'replay' }> {
  const stored = found.request_hash
  if (!(stored instanceof Uint8Array) || !call.requestHash.equals(Buffer.from(stored))) {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  if (typeof found.status !== 'number') {
    throw inProgress()
  }
  return { kind: 'replay', status: found.status, response: found.response }
}

/** Stores the answer under the key reserved by {@link reserveKey}; a call with no key stores nothing. */
export async function completeKey(
  run: Run,
  call: KeyedRequest,
  status: number,
  body: unknown
): Promise<void> {
  if (call.key === undefined) {
    return
  }
  await run(IDEMPOTENCY_COMPLETE, [
    call.organizationId,
    call.userId,
    call.route,
    call.key,
    status,
    JSON.stringify(body),
  ])
}
