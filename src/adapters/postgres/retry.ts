/** Postgres SQLSTATE for a serialization failure, which `REPEATABLE READ` and `SERIALIZABLE` raise. */
export const SERIALIZATION_FAILURE = '40001'

/** Postgres SQLSTATE for a deadlock the server broke by cancelling this transaction. */
export const DEADLOCK_DETECTED = '40P01'

/** Postgres SQLSTATE for a lock wait that outlasted `lock_timeout`. */
export const LOCK_NOT_AVAILABLE = '55P03'

/** Whether the failure is a lock wait that outlasted `lock_timeout`: nothing changed, try again later. */
export function isLockTimeout(error: unknown): boolean {
  return postgresErrorOf(error)?.code === LOCK_NOT_AVAILABLE
}

/** How many times a transaction runs in all: the first try and two retries (ADR 0011). */
export const MAX_ATTEMPTS = 3

/** The delay ceiling of the first retry; each later one doubles it. */
const BASE_DELAY_MS = 20

/** The longest any one wait may last, however many attempts there are. */
const MAX_DELAY_MS = 200

/** How deep a `cause` chain is followed, which also bounds a cyclic chain. */
const MAX_CAUSE_DEPTH = 8

/** The fields of a Postgres error that the store reads, found anywhere in a `cause` chain. */
export type PostgresErrorInfo = { code?: string; constraint?: string; message: string }

/**
 * Finds the Postgres error inside `error`: the driver error itself, or the one the query builder
 * wrapped it in. Returns the first error in the chain that carries a five-character SQLSTATE.
 */
export function postgresErrorOf(error: unknown): PostgresErrorInfo | undefined {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const code: unknown = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      const constraint: unknown = (current as { constraint?: unknown }).constraint
      return {
        code,
        ...(typeof constraint === 'string' ? { constraint } : {}),
        message: current.message,
      }
    }
    current = current.cause
  }
  return undefined
}

/** Whether the failure is one that running the whole transaction again can cure. */
export function isRetryable(error: unknown): boolean {
  const code = postgresErrorOf(error)?.code
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED
}

/** What {@link retryTransaction} reads from the outside world; tests replace both. */
export type RetryOptions = {
  /** Waits `ms`; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
  /** A number in [0, 1) for jitter; defaults to `Math.random`. */
  random?: () => number
}

/**
 * Runs `transaction`, and runs it again from the start if Postgres cancelled it with a
 * serialization failure or a deadlock, up to {@link MAX_ATTEMPTS} runs in all. Each wait is a
 * random time up to a ceiling that doubles per retry ("full jitter"), so contending callers
 * spread out. Any other failure, and the last retryable one, is thrown as it came. The work in
 * `transaction` must be nothing but the transaction, because it can run more than once.
 */
export async function retryTransaction<T>(
  transaction: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random
  for (let attempt = 1; ; attempt++) {
    try {
      return await transaction()
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
        throw error
      }
      await sleep(Math.floor(random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1))))
    }
  }
}
