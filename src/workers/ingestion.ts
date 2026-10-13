import {
  type ClaimedIngestionJob,
  claimedJobs,
  INGESTION_JOB_CLAIM,
  INGESTION_JOB_GIVE_UP_SPENT,
  type IngestionJobClaimRow,
} from 'tula-closeline-db'
import { isLockTimeout } from '~/adapters/postgres/retry'
import { runJob } from '~/modules/ingestion/job'
import {
  CLAIM_LOCK_TIMEOUT_SQL,
  inTransaction,
  jittered,
  type PipelineDeps,
  reportWorkerError,
  ShuttingDown,
} from '~/modules/ingestion/runtime'
import { forEachOrganization } from './discovery'

/** The most claim rounds one Organization gets in a pass when the claim only cancelled or lost jobs. */
const MAX_EMPTY_ROUNDS = 10

/** The most spent jobs one Organization's pass fails. */
const GIVE_UP_BATCH = 20

/** The most Organizations an uploaded-message nudge remembers; a nudge is only a hint. */
const MAX_NUDGED = 1_000

/** The job loop of one instance. */
export interface Ingestion {
  /**
   * One pass: Organizations nudged since the last pass first, then every Organization the database
   * names for `jobs_due`. Jobs run in one pool bounded by `INGESTION_CONCURRENCY` across all
   * Organizations: each Organization is claimed for as many jobs as there are free slots and the
   * pass moves on without waiting for them, so a long job idles no slot and delays no other
   * Organization's claim. The pass returns when its jobs have ended, with the number run.
   */
  runPass(): Promise<number>
  /** Asks the loop to look at an Organization at once. Only a hint: losing it loses nothing. */
  nudge(organizationId: string): void
  /** Starts the loop in the background; calling it twice does nothing. */
  start(): void
  /**
   * Stops claiming, cancels every call in flight (their jobs are released at the step they reached,
   * due again at once, or left to lapse if the database cannot be told) and waits up to `deadlineMs`
   * for the loop and the pool.
   */
  stop(deadlineMs: number): Promise<void>
}

/** Creates the job loop over `deps`; nothing runs until `start` or `runPass`. */
export function createIngestion(deps: PipelineDeps): Ingestion {
  const { env } = deps
  const shutdown = new AbortController()
  const nudged = new Set<string>()
  let wake: AbortController | undefined
  let running: Promise<void> | undefined

  /** The jobs running now, across every Organization: one pool bounded by `INGESTION_CONCURRENCY`. */
  const active = new Set<Promise<void>>()

  /** Starts a job in the pool without waiting for it; a failing job reports and frees its slot. */
  function launch(
    organizationId: string,
    job: ClaimedIngestionJob,
    mine: Set<Promise<void>>
  ): void {
    const task: Promise<void> = runJob(deps, organizationId, job, shutdown.signal)
      .then(
        () => undefined,
        (error: unknown) => reportWorkerError(deps, error, { worker: 'ingestion', organizationId })
      )
      .finally(() => {
        active.delete(task)
      })
    active.add(task)
    mine.add(task)
  }

  /** Waits until the pool has a free slot (or shutdown). */
  async function freeSlot(): Promise<void> {
    while (active.size >= env.INGESTION_CONCURRENCY && !shutdown.signal.aborted) {
      await Promise.race(active)
    }
  }

  async function claimAndRun(organizationId: string, mine: Set<Promise<void>>): Promise<number> {
    let ran = 0
    for (let round = 0; round < MAX_EMPTY_ROUNDS && !shutdown.signal.aborted; round++) {
      await freeSlot()
      if (shutdown.signal.aborted) {
        break
      }
      const free = env.INGESTION_CONCURRENCY - active.size
      let rows: readonly IngestionJobClaimRow[]
      try {
        rows = (
          await inTransaction(deps, organizationId, async (run) => {
            await run(CLAIM_LOCK_TIMEOUT_SQL, [])
            return run(INGESTION_JOB_CLAIM, [organizationId, free, env.INGESTION_LEASE_MS, null])
          })
        ).rows as unknown as IngestionJobClaimRow[]
      } catch (error) {
        if (isLockTimeout(error)) {
          // A delete holds a document: nothing was claimed; the next pass looks again.
          deps.logger.debug('a job claim waited too long for a lock', { organizationId })
          break
        }
        throw error
      }
      const { jobs, cancelled, lost } = claimedJobs(rows)
      if (jobs.length > 0) {
        for (const job of jobs) {
          launch(organizationId, job, mine)
        }
        ran += jobs.length
        break
      }
      if (cancelled === 0 && lost === 0) {
        break
      }
    }
    if (!shutdown.signal.aborted) {
      const spent = await inTransaction(deps, organizationId, (run) =>
        run(INGESTION_JOB_GIVE_UP_SPENT, [organizationId, GIVE_UP_BATCH])
      )
      if (spent.rows.length > 0) {
        deps.logger.error('ingestion jobs reached the database attempt bound', {
          organizationId,
          jobs: spent.rows.length,
        })
      }
    }
    return ran
  }

  /** One pass that waits for the jobs it started (tests and one-shot runs); the loop does not. */
  async function runPass(): Promise<number> {
    const mine = new Set<Promise<void>>()
    try {
      return await passOver(mine)
    } finally {
      await Promise.all(mine)
    }
  }

  async function passOver(mine: Set<Promise<void>>): Promise<number> {
    let ran = 0
    const first = [...nudged]
    nudged.clear()
    const done = new Set<string>()
    for (const organizationId of first) {
      if (shutdown.signal.aborted) {
        return ran
      }
      done.add(organizationId)
      try {
        ran += await claimAndRun(organizationId, mine)
      } catch (error) {
        reportWorkerError(deps, error, { worker: 'ingestion', organizationId })
      }
    }
    await forEachOrganization(deps, 'jobs_due', shutdown.signal, async (organizationId) => {
      if (!done.has(organizationId)) {
        ran += await claimAndRun(organizationId, mine)
      }
    })
    return ran
  }

  async function loop(): Promise<void> {
    while (!shutdown.signal.aborted) {
      let ran = 0
      try {
        // Jobs are not awaited: they run in the pool while the loop looks for more work, so one
        // long job never idles the other slots. With the pool full the loop waits for a slot.
        await freeSlot()
        ran = await passOver(new Set())
      } catch (error) {
        reportWorkerError(deps, error, { worker: 'ingestion' })
      }
      if (shutdown.signal.aborted) {
        return
      }
      if (ran > 0) {
        continue
      }
      wake = new AbortController()
      await deps.sleep(
        jittered(deps, env.INGESTION_POLL_INTERVAL_MS),
        AbortSignal.any([shutdown.signal, wake.signal])
      )
      wake = undefined
    }
  }

  return {
    runPass,
    nudge: (organizationId) => {
      if (nudged.size < MAX_NUDGED) {
        nudged.add(organizationId)
      }
      wake?.abort()
    },
    start: () => {
      running ??= loop()
    },
    stop: async (deadlineMs) => {
      shutdown.abort(new ShuttingDown())
      wake?.abort()
      const timer = new AbortController()
      // The loop, then every job in the pool: each is released at its step or left to lapse.
      const drained = (running ?? Promise.resolve()).then(() => Promise.all(active))
      await Promise.race([drained, deps.sleep(deadlineMs, timer.signal)])
      timer.abort()
    },
  }
}
