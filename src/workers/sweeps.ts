import type { ProcessedStore } from 'tula-closeline-kit'
import {
  jittered,
  type PipelineDeps,
  reportWorkerError,
  ShuttingDown,
} from '~/modules/ingestion/runtime'
import { cleanupPending } from '~/modules/maintenance/cleanup-pending'
import {
  logSpentPurges,
  purgeConsumedMessages,
  purgeIdempotencyKeys,
  sweepOrphanObjects,
} from '~/modules/maintenance/housekeeping'
import { purgeDue } from '~/modules/maintenance/purge'
import { forEachOrganization } from './discovery'

/** The periodic sweeps of one instance. */
export type SweepName = 'cleanup' | 'purge' | 'housekeeping'

/** The all-zero Organization id of the global scope, which has no documents or objects. */
const GLOBAL_SCOPE = `org_${'0'.repeat(32)}`

/** The sweeps; every instance runs all of them, and the database's leases and `skip locked` keep them from clashing. */
export interface Sweeps {
  /** Runs one sweep once, now, to its end (a test, or a one-shot job). */
  run(name: SweepName): Promise<void>
  /** Starts every sweep's loop in the background; a second call does nothing. */
  start(): void
  /** Stops the loops and waits up to `deadlineMs` for the running pass to reach a boundary. */
  stop(deadlineMs: number): Promise<void>
}

/**
 * Builds the sweeps. Each is a loop over `ORGANIZATIONS_WITH_WORK` for its kind (discovery is
 * unscoped and alone in its transaction, then each Organization is worked in its own scope):
 *
 * - `cleanup`: `cleanup_pending`, the vector cleanup of deletions whose message was lost.
 * - `purge`: `purge_due`, documents past retention or erased.
 * - `housekeeping`: consumed messages (`consumed_purge`), idempotency keys (`idempotency_purge`),
 *   the spent purges (`purge_spent`, logged for a person) and the orphan objects.
 *
 * Intervals come from the settings, jittered; the first run of each is spread over its interval.
 */
export function createSweeps(deps: PipelineDeps, processed: ProcessedStore): Sweeps {
  const { env } = deps
  const shutdown = new AbortController()
  const signal = shutdown.signal
  let loops: Promise<void>[] | undefined

  async function housekeeping(): Promise<void> {
    const attempt = async (worker: string, step: () => Promise<unknown>): Promise<void> => {
      try {
        await step()
      } catch (error) {
        reportWorkerError(deps, error, { worker })
      }
    }
    // There is no work kind for orphan objects: the sweep visits the Organizations that other
    // background work names, once each per pass, before the purges below drop the records
    // (an aged idempotency key) that name them.
    const visited = new Set<string>([GLOBAL_SCOPE])
    for (const kind of ['consumed_purge', 'idempotency_purge', 'purge_due'] as const) {
      await attempt('orphan_objects', () =>
        forEachOrganization(deps, kind, signal, async (organizationId) => {
          if (!visited.has(organizationId)) {
            visited.add(organizationId)
            await sweepOrphanObjects(deps, organizationId, signal)
          }
        })
      )
    }
    await attempt('consumed_purge', () => purgeConsumedMessages(deps, processed))
    await attempt('idempotency_purge', () =>
      forEachOrganization(deps, 'idempotency_purge', signal, async (organizationId) => {
        await purgeIdempotencyKeys(deps, organizationId)
      })
    )
    await attempt('purge_spent', () =>
      forEachOrganization(deps, 'purge_spent', signal, async (organizationId) => {
        await logSpentPurges(deps, organizationId)
      })
    )
  }

  const sweeps: Record<SweepName, { intervalMs: number; run: () => Promise<void> }> = {
    cleanup: {
      intervalMs: env.SWEEP_INTERVAL_MS,
      run: async () => {
        await forEachOrganization(deps, 'cleanup_pending', signal, async (organizationId) => {
          await cleanupPending(deps, organizationId, signal)
        })
      },
    },
    purge: {
      intervalMs: env.SWEEP_INTERVAL_MS,
      run: async () => {
        await forEachOrganization(deps, 'purge_due', signal, async (organizationId) => {
          await purgeDue(deps, organizationId, signal)
        })
      },
    },
    housekeeping: { intervalMs: env.HOUSEKEEPING_INTERVAL_MS, run: housekeeping },
  }

  async function loop(name: SweepName): Promise<void> {
    const { intervalMs, run } = sweeps[name]
    // Spread the first run, so instances that start together do not sweep together.
    await deps.sleep(Math.floor(deps.random() * intervalMs), signal)
    while (!signal.aborted) {
      try {
        await run()
      } catch (error) {
        reportWorkerError(deps, error, { worker: `sweep.${name}` })
      }
      await deps.sleep(jittered(deps, intervalMs), signal)
    }
  }

  return {
    run: (name) => sweeps[name].run(),
    start: () => {
      loops ??= (Object.keys(sweeps) as SweepName[]).map((name) => loop(name))
    },
    stop: async (deadlineMs) => {
      shutdown.abort(new ShuttingDown())
      const timer = new AbortController()
      await Promise.race([Promise.all(loops ?? []), deps.sleep(deadlineMs, timer.signal)])
      timer.abort()
    },
  }
}
