import { formatId } from 'tula-closeline-contract'
import type { ErrorContext } from '~/container'

/** How long a non-zero exit gives `close` (a Sentry flush, the pool) before it exits regardless. */
export const FORCED_CLOSE_DEADLINE_MS = 2_000

/** What {@link exitAfterClose} needs; plain values so a test can supply doubles. */
export type ExitOptions = {
  /** The exit code shutdown ended with. */
  code: number
  /** Delivers pending error reports and releases connections; may never settle. */
  close: () => Promise<void>
  /** Ends the process. */
  exit: (code: number) => void
  /** The most a non-zero exit waits for `close`; default {@link FORCED_CLOSE_DEADLINE_MS}. */
  deadlineMs?: number
}

/**
 * Ends the process after `close`. A clean stop (code 0) waits for `close` and exits 1 if it fails.
 * A non-zero stop gives `close` only `deadlineMs`, so a stuck pool or a slow flush cannot push
 * shutdown past the orchestrator's kill window, and then exits with the original code.
 */
export function exitAfterClose(options: ExitOptions): void {
  const { code, close, exit } = options
  if (code === 0) {
    Promise.resolve()
      .then(close)
      .then(
        () => exit(0),
        () => exit(1)
      )
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, options.deadlineMs ?? FORCED_CLOSE_DEADLINE_MS)
  })
  Promise.race([
    Promise.resolve()
      .then(close)
      .catch(() => undefined),
    deadline,
  ]).then(() => {
    clearTimeout(timer)
    exit(code)
  })
}

/** What {@link installCrashHandlers} needs. */
export type CrashHandlerOptions = {
  /** The process, or a double with `on`. */
  target: {
    on: (
      event: 'uncaughtException' | 'unhandledRejection',
      listener: (e: unknown) => void
    ) => unknown
  }
  /** Reports through the container's error seam; it must not throw but a throw is survived. */
  report: (error: unknown, context: ErrorContext) => void
  /** Stops the queue consumer receiving; called with a zero deadline and never awaited past the exit deadline. */
  stopReceiving?: (deadlineMs: number) => unknown
  close: () => Promise<void>
  exit: (code: number) => void
  deadlineMs?: number
}

/**
 * Reports an uncaught exception or unhandled rejection through the error reporter (the kit turns
 * off the SDK's own global handlers) and exits 1 through {@link exitAfterClose}. Only the first
 * failure acts; the process is already on its way out.
 */
export function installCrashHandlers(options: CrashHandlerOptions): void {
  let exiting = false
  const handle = (error: unknown): void => {
    if (exiting) {
      return
    }
    exiting = true
    try {
      options.report(error, {
        requestId: formatId('req', crypto.randomUUID()),
        method: 'PROCESS',
        path: 'process',
        status: 500,
      })
    } catch {
      // A failing reporter must not keep a crashed process alive.
    }
    try {
      // No new work after a crash; what is in flight goes back to the queue, and the exit does
      // not wait for it beyond the close deadline.
      Promise.resolve(options.stopReceiving?.(0)).catch(() => undefined)
    } catch {
      // A consumer that cannot stop must not keep a crashed process alive.
    }
    exitAfterClose({
      code: 1,
      close: options.close,
      exit: options.exit,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    })
  }
  options.target.on('uncaughtException', handle)
  options.target.on('unhandledRejection', handle)
}
