/** The longest error message written to a log line; the kit redacts by key, not by content. */
export const MAX_LOGGED_MESSAGE = 200

/** The most stack frames written for one error. */
const MAX_FRAMES = 12

/** How deep a `cause` chain is followed, which also bounds a cyclic chain. */
const MAX_CAUSE_DEPTH = 5

/** The longest stack frame line written to a log. */
const MAX_FRAME_LENGTH = 300

/** A genuine frame: `at` then anything, ending in a file position such as `:12:5` or `:12:5)`. */
const FRAME = /^\s*at\s.*:\d+(?::\d+)?\)?$/

/**
 * The frame lines of a stack. The leading lines that belong to the message are dropped first
 * (counted from the message), then only lines shaped like a frame are kept, so message text can
 * never come through, and each frame and the frame count are bounded.
 */
function frames(error: Error): string[] {
  const lines = error.stack?.split('\n') ?? []
  const first = lines[0] ?? ''
  const messageLines = FRAME.test(first) ? 0 : error.message.split('\n').length
  return lines
    .slice(messageLines)
    .filter((line) => FRAME.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim().slice(0, MAX_FRAME_LENGTH))
}

/** What is logged for a field that could not be read, so the line still says something was there. */
const UNREADABLE = '[unreadable]'

/** The longest `name` or `code` written to a log line. */
const MAX_IDENTIFIER_LENGTH = 64

/** A safe identifier: word characters, dots, colons and dashes, so one line and no free text. */
const SAFE_IDENTIFIER = /^[\w.:-]+$/

/** Logged in place of a `name` that is not a safe identifier. */
const UNSAFE_NAME = 'UnsafeName'

/** Logged in place of a `code` that is not a safe identifier. */
const UNSAFE_CODE = 'unsafe.code'

/** Reads a value that may be a throwing getter, falling back instead of throwing. */
function read<T, F>(get: () => T, fallback: F): T | F {
  try {
    return get()
  } catch {
    return fallback
  }
}

/**
 * Cuts a name or code to 64 characters and keeps it only if it is a safe single-line identifier;
 * the kit redacts by field name, not content, so free text in these fields would reach the log.
 */
function identifier(value: string, fallback: string): string {
  const cut = value.slice(0, MAX_IDENTIFIER_LENGTH)
  return SAFE_IDENTIFIER.test(cut) ? cut : fallback
}

/** The error's own name, or its class name when it kept the default `Error` (Hono's exceptions). */
function nameOf(error: Error): string {
  const name: unknown = error.name
  if (typeof name !== 'string') {
    return UNSAFE_NAME
  }
  const className: unknown = error.constructor?.name
  const chosen =
    name === 'Error' && typeof className === 'string' && className !== 'Error' ? className : name
  return identifier(chosen, UNSAFE_NAME)
}

/** The `status` and `code` an error carries (AppError, HTTPException), when it has them. */
function statusAndCode(error: Error): { status?: number | string; code?: string } {
  const status: unknown = read(() => (error as { status?: unknown }).status, UNREADABLE)
  const code: unknown = read(() => (error as { code?: unknown }).code, UNREADABLE)
  return {
    ...(typeof status === 'number' || status === UNREADABLE ? { status } : {}),
    ...(typeof code === 'string'
      ? { code: code === UNREADABLE ? code : identifier(code, UNSAFE_CODE) }
      : {}),
  }
}

/** The bounded message, or `[unreadable]` when reading it throws or it is not a string. */
function messageOf(error: Error): string {
  const message: unknown = read(() => error.message, UNREADABLE)
  return typeof message === 'string' ? message.slice(0, MAX_LOGGED_MESSAGE) : UNREADABLE
}

/**
 * Describes an error for a log line: name, status and code when it has them, a bounded message,
 * the stack frames without the message text, and the `cause` chain. Name and code are cut to 64
 * characters and must be a safe single-line identifier, else a fixed fallback is logged; this holds
 * at every level of the chain. A value that is not an Error is described by its type only, never
 * its content. It never throws: each field is read on its own and a throwing getter shows as
 * `[unreadable]`.
 */
export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!read(() => error instanceof Error, false)) {
    return { name: 'NonError', type: typeof error }
  }
  const err = error as Error
  const cause: unknown = read(() => err.cause, UNREADABLE)
  return {
    name: read(() => nameOf(err), UNREADABLE),
    ...statusAndCode(err),
    message: messageOf(err),
    stack: read(() => frames(err), [UNREADABLE]),
    ...(cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? { cause: cause === UNREADABLE ? cause : describeError(cause, depth + 1) }
      : {}),
  }
}
