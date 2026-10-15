import type { ErrorReporter } from 'tula-closeline-kit'
import { frames } from './describe-error'

/** How deep a `cause` chain is followed; it also ends a cyclic chain. */
const MAX_CAUSE_DEPTH = 5

/**
 * The fields of a Postgres error that name what failed and never hold data: the SQLSTATE class and
 * code, the severity, and the schema, table, column, constraint and data type involved. `detail`,
 * `where`, `hint`, `internalQuery` and `parameters` are left out: `detail` can carry a whole row
 * (speaker labels, file names) and `where` can quote one.
 */
const KEPT_FIELDS = [
  'severity',
  'code',
  'schema',
  'table',
  'column',
  'dataType',
  'constraint',
  'routine',
] as const

/** A five-character SQLSTATE. */
const SQLSTATE = /^[0-9A-Z]{5}$/

/** True for an error from the database layer: a `pg` error (SQLSTATE and severity) or drizzle's wrapper of one. */
function isDatabaseError(error: Error): boolean {
  const fields = error as unknown as Record<string, unknown>
  return (
    error.name === 'DrizzleQueryError' ||
    ('query' in fields && 'params' in fields) ||
    (typeof fields.code === 'string' && SQLSTATE.test(fields.code) && 'severity' in fields)
  )
}

/** The error's `cause`, or undefined when reading it throws. */
function causeOf(error: Error): unknown {
  try {
    return error.cause
  } catch {
    return undefined
  }
}

/**
 * A copy of a database error for the error tracker: the name, a message that is only the SQLSTATE,
 * the kept fields, the stack frames without the message line, and the scrubbed cause. Drizzle's
 * message holds the SQL and every parameter value and `pg`'s can quote a value, so neither is kept.
 */
function scrubDatabaseError(error: Error, depth: number): Error {
  const fields = error as unknown as Record<string, unknown>
  const code = typeof fields.code === 'string' && SQLSTATE.test(fields.code) ? fields.code : null
  const clean = new Error(code === null ? 'database error' : `database error ${code}`)
  clean.name =
    typeof error.name === 'string' && /^[\w.:-]{1,64}$/.test(error.name)
      ? error.name
      : 'DatabaseError'
  clean.stack = `${clean.name}: ${clean.message}\n${frames(error).join('\n')}`
  for (const key of KEPT_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string' && value.length <= 128) {
      Object.defineProperty(clean, key, { value, enumerable: true, configurable: true })
    }
  }
  const cause = causeOf(error)
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    clean.cause = scrub(cause, depth + 1)
  }
  return clean
}

/** {@link scrubForTracker} at a depth in the cause chain. */
function scrub(error: unknown, depth: number): unknown {
  if (!(error instanceof Error)) {
    return error
  }
  if (isDatabaseError(error)) {
    return scrubDatabaseError(error, depth)
  }
  const cause = causeOf(error)
  const members = error instanceof AggregateError ? error.errors : undefined
  const cleanCause =
    cause instanceof Error && depth < MAX_CAUSE_DEPTH ? scrub(cause, depth + 1) : cause
  // An AggregateError's members are children like a cause is: scrubbed with the same depth bound.
  const cleanMembers = members?.map((member) =>
    depth < MAX_CAUSE_DEPTH ? scrub(member, depth + 1) : new Error('too deep')
  )
  const causeChanged = cause instanceof Error && cleanCause !== cause
  const membersChanged = cleanMembers?.some((member, at) => member !== members?.[at]) === true
  if (!causeChanged && !membersChanged) {
    return error
  }
  // Not a database error itself, but it wraps one: copy it with the children scrubbed.
  const copy = Object.create(Object.getPrototypeOf(error)) as Error
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(error))
  if (causeChanged) {
    Object.defineProperty(copy, 'cause', {
      value: cleanCause,
      enumerable: false,
      writable: true,
      configurable: true,
    })
  }
  if (membersChanged) {
    Object.defineProperty(copy, 'errors', {
      value: cleanMembers,
      enumerable: false,
      writable: true,
      configurable: true,
    })
  }
  return copy
}

/**
 * What the error tracker may receive for an error (issue 76): a Postgres error, alone or as the
 * cause of another error, is replaced by a copy that keeps what failed (SQLSTATE, table,
 * constraint, stack frames) and drops everything that can carry a row, a parameter or a quoted
 * value. Errors inside an `AggregateError` are covered as well. Any other error is returned as it
 * is; the argument is never changed. A wrapper that copies a database error's message into its own
 * text is not caught: wrap with `cause`.
 */
export function scrubForTracker(error: unknown): unknown {
  try {
    return scrub(error, 0)
  } catch {
    // An error that cannot be read safely is not sent in its own words.
    return new Error('an error that could not be scrubbed')
  }
}

/** An error reporter that scrubs every error with {@link scrubForTracker} before the tracker sees it. */
export function trackerSafe(reporter: ErrorReporter): ErrorReporter {
  return {
    capture: (error, context) => reporter.capture(scrubForTracker(error), context),
    flush: (timeoutMs) => reporter.flush(timeoutMs),
    close: (timeoutMs) => reporter.close(timeoutMs),
  }
}
