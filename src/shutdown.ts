import type { Clock } from 'tula-closeline-kit'
import { describeError } from '~/describe-error'

/** The part of a running server that shutdown needs; `Bun.serve`'s return value satisfies it. */
export type Stoppable = {
  /** Stops accepting connections; `force` also closes in-flight ones. Resolves once stopped. */
  stop: (force?: boolean) => Promise<void>
}

/**
 * Combines the server and the queue consumer into one thing to stop. Stopping it stops receiving
 * new messages and lets the ones in flight finish for up to `deadlineMs`, after which they are
 * given back to the queue; a forced stop adds nothing, as the consumer's own deadline has run.
 */
export function stoppableWith(
  server: Stoppable,
  consumer: { stop: (deadlineMs: number) => Promise<unknown> },
  deadlineMs: number
): Stoppable {
  return {
    stop: async (force) => {
      await Promise.all([server.stop(force), consumer.stop(force ? 0 : deadlineMs)])
    },
  }
}

/** How a drain ended: every request finished, or the timeout closed the rest. */
export type DrainResult = 'drained' | 'forced'

/**
 * Stops accepting new connections, waits for in-flight requests, and after `timeoutMs` closes
 * whatever is left, so a stuck request can never keep the process alive.
 */
export async function drain(server: Stoppable, timeoutMs: number): Promise<DrainResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'forced'>((resolve) => {
    timer = setTimeout(() => resolve('forced'), timeoutMs)
  })

  try {
    const result = await Promise.race([server.stop().then(() => 'drained' as const), timeout])
    if (result === 'forced') {
      await server.stop(true)
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/** What {@link shutdown} needs; kept to plain values so a test can supply doubles. */
export type ShutdownOptions = {
  signal: string
  server: Stoppable
  /** The container's flag; `/readyz` reads it. */
  lifecycle: { draining: boolean; drainingSince?: number }
  /** The container's clock, which times the gap between two signals (never `Date.now()`). */
  clock: Clock
  logger: {
    info: (message: string, fields?: Record<string, unknown>) => void
    error: (message: string, fields?: Record<string, unknown>) => void
  }
  /** How long to keep serving `/readyz` as 503 before the server stops accepting. */
  graceMs: number
  /** How long to wait for in-flight requests once stopped, before closing them. */
  timeoutMs: number
  /** Ends the process; called once when shutdown ends, or at once with 1 on a later signal. */
  exit: (code: number) => void
}

/** Runs a logging call that must never be able to change how shutdown ends. */
function safely(log: () => void): void {
  try {
    log()
  } catch {
    // A broken log destination (closed stdout) is no reason to leave the process hanging.
  }
}

/** A repeat signal sooner than this after the first is taken as a duplicate and ignored. */
export const FORCE_AFTER_MS = 1_000

/**
 * Graceful shutdown: readiness turns 503 first, a grace period lets the load balancer notice, and
 * only then the server stops accepting and drains. It always ends by calling `exit`, with code 1
 * if stopping failed, and nothing in it, a throwing logger included, can prevent that. A second
 * signal that arrives at least {@link FORCE_AFTER_MS} after the first exits at once with code 1,
 * for a person who will not wait. An earlier one is ignored: a wrapper (`bun run`, a shell)
 * forwards the terminal's Ctrl-C to the process that already received it, so the same keypress
 * can arrive twice within milliseconds and must not skip the drain.
 */
export async function shutdown(options: ShutdownOptions): Promise<void> {
  const { server, lifecycle, logger } = options
  const now = options.clock.now().getTime()
  if (lifecycle.draining) {
    if (now - (lifecycle.drainingSince ?? now) >= FORCE_AFTER_MS) {
      options.exit(1)
    }
    return
  }
  lifecycle.draining = true
  lifecycle.drainingSince = now

  let code = 0
  try {
    safely(() => logger.info('shutting down', { signal: options.signal, graceMs: options.graceMs }))
    await new Promise<void>((resolve) => setTimeout(resolve, options.graceMs))
    const result = await drain(server, options.timeoutMs)
    safely(() => logger.info('stopped', { result }))
  } catch (error) {
    code = 1
    safely(() => logger.error('shutdown failed', { error: describeError(error) }))
  } finally {
    options.exit(code)
  }
}
