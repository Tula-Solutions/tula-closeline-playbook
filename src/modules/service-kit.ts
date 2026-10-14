import {
  ALL_PLAYBOOK_ERRORS,
  ERRORS,
  type OrganizationId,
  type RequestId,
  type Role,
  type UserId,
} from 'tula-closeline-contract'
import { StorageError } from 'tula-closeline-kit'
import type { Run } from '~/adapters/postgres/processed-store'
import { isLockTimeout, postgresErrorOf, retryTransaction } from '~/adapters/postgres/retry'
import type { Container } from '~/container'
import { domainError, RetryAfterError } from '~/http/domain-error'

/** The seconds a busy answer asks the caller to wait. */
export const RETRY_AFTER_SECONDS = 1

/** Who is calling and which request it is: the Organization and role come from the verified token only. */
export type CallContext = {
  userId: UserId
  organizationId: OrganizationId
  role: Role
  requestId: RequestId
}

const ALL_ERRORS = { ...ERRORS, ...ALL_PLAYBOOK_ERRORS }

/** The AppError for a code the contract's checks or the database's answers can name. */
export function failure(code: keyof typeof ALL_ERRORS) {
  return domainError(ALL_ERRORS[code])
}

/** Refuses a caller whose role is not in `roles` with the common `auth.forbidden`. */
export function assertRole(context: Pick<CallContext, 'role'>, roles: readonly Role[]): void {
  if (!roles.includes(context.role)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
}

/**
 * The errors raised while a transaction's work was running, before its commit was sent. Such an
 * error means the transaction did not commit, whatever it was (a statement the server refused, a
 * dropped connection, a bug), because the commit is only sent after the work returns. An error
 * that is not in this set came from before the work or from the commit or release, where the
 * server may or may not have applied the change.
 */
export const raisedBeforeCommit = new WeakSet<object>()

/** Makes a transaction that can run again after a deadlock or a serialization failure, then maps a lock timeout to a retryable 503. */
export async function transaction<T>(
  deps: Pick<Container, 'scope'>,
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

/**
 * The SQLSTATE class of data exceptions (22007 invalid syntax, 22008 field overflow, 22003 and so
 * on). A list statement's only caller-chosen input is the cursor text, so any of them means the
 * cursor cannot be read.
 */
const DATA_EXCEPTION_CLASS = '22'

/**
 * Runs a list statement and maps any data exception from the database to `request.invalid`, with
 * the fixed message of that code, so the cursor text is never echoed or logged.
 */
export async function mappingBadCursor<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (postgresErrorOf(error)?.code?.startsWith(DATA_EXCEPTION_CLASS) === true) {
      throw failure('request.invalid')
    }
    throw error
  }
}

/** SQLSTATEs that a later attempt can cure: serialization, deadlock, a lost or restarting server, too many connections. */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '57P01', '57P02', '57P03', '53300'])

/** Whether a failure is one a repeat of the request can cure: a lost database connection or restart, an exhausted retry of a serialization failure, a lock timeout, or an object store that did not answer. */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof StorageError) {
    return error.code === 'storage.unavailable'
  }
  const code = postgresErrorOf(error)?.code
  return code !== undefined && (code.startsWith('08') || TRANSIENT_SQLSTATES.has(code))
}
