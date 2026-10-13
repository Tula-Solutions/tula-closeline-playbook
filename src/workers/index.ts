import type { ProcessedStore } from 'tula-closeline-kit'
import type { PipelineDeps } from '~/modules/ingestion/runtime'
import { createIngestion, type Ingestion } from './ingestion'
import { createSweeps, type Sweeps } from './sweeps'

/** Everything that runs in the background on one instance. */
export interface Workers {
  /** The job loop; also the target of the uploaded-message nudge. */
  ingestion: Ingestion
  /** The periodic sweeps. */
  sweeps: Sweeps
  /** Starts the job loop (if `WORKERS_ENABLED`) and the sweeps (if `SWEEPS_ENABLED`); a second call does nothing. */
  start(): void
  /**
   * Stops them for shutdown: no new claim or sweep pass starts, calls in flight are cancelled, a
   * running job is given back at its step (due again at once) or left to lapse, and this waits up
   * to `deadlineMs` in all.
   */
  stop(deadlineMs: number): Promise<void>
}

/** Builds the background workers over `deps`; nothing runs until `start`. */
export function createWorkers(deps: PipelineDeps, processed: ProcessedStore): Workers {
  const ingestion = createIngestion(deps)
  const sweeps = createSweeps(deps, processed)
  return {
    ingestion,
    sweeps,
    start: () => {
      // Two switches: the job loop needs real adapters, the sweeps do not (they must run
      // wherever documents can be deleted, or nothing is ever purged).
      if (deps.env.WORKERS_ENABLED) {
        ingestion.start()
      }
      if (deps.env.SWEEPS_ENABLED) {
        sweeps.start()
      }
    },
    stop: async (deadlineMs) => {
      await Promise.all([ingestion.stop(deadlineMs), sweeps.stop(deadlineMs)])
    },
  }
}
