import { PACKAGE as CONTRACT } from 'tula-closeline-contract'
import { PACKAGE as DB } from 'tula-closeline-db'
import { PACKAGE as KIT } from 'tula-closeline-kit'
import type { Container, ReadinessCheck } from '~/container'
import { describeError } from '~/describe-error'
import { SERVICE } from '~/info'
import type { CheckResult, Liveness, Readiness } from './schema'

/** What the health service needs from the container. */
export type HealthDeps = Pick<Container, 'env' | 'logger' | 'readinessChecks' | 'lifecycle'>

/** Liveness: the process is up. It touches no dependency, so it cannot fail because of one. */
export function liveness(): Liveness {
  return { status: 'ok', service: SERVICE, libraries: [CONTRACT, DB, KIT] }
}

type CheckOutcome = { status: CheckResult['status']; error?: unknown }

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<CheckOutcome> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<CheckOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ status: 'timeout' })
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      // Started inside an async function so a check that throws before returning a promise is a
      // failed check, not a server error.
      (async () => check.run(controller.signal))().then(
        (): CheckOutcome => ({ status: 'ok' }),
        (error: unknown): CheckOutcome => ({ status: 'failed', error })
      ),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Readiness: runs every check at once, each with its own timeout; ready only if all pass. Once
 * shutdown has begun it is unavailable without running anything, so traffic moves away first.
 * The reason a check failed is logged here and never returned to the caller.
 */
export async function readiness(deps: HealthDeps): Promise<Readiness> {
  if (deps.lifecycle.draining) {
    return { status: 'unavailable', checks: [] }
  }

  const outcomes = await Promise.all(
    deps.readinessChecks.map(async (check) => ({
      name: check.name,
      outcome: await runCheck(check, deps.env.READINESS_TIMEOUT_MS),
    }))
  )

  for (const { name, outcome } of outcomes) {
    if (outcome.status !== 'ok') {
      deps.logger.warn('readiness check did not pass', {
        check: name,
        status: outcome.status,
        ...(outcome.error === undefined ? {} : { error: describeError(outcome.error) }),
      })
    }
  }

  const checks = outcomes.map(
    ({ name, outcome }): CheckResult => ({ name, status: outcome.status })
  )
  return {
    status: checks.every((check) => check.status === 'ok') ? 'ready' : 'unavailable',
    checks,
  }
}
