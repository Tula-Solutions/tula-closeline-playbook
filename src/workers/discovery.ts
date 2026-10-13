import { discoveredOrganizations } from 'tula-closeline-db'
import type { WorkKind } from '~/adapters/postgres/processed-store'
import { type PipelineDeps, reportWorkerError } from '~/modules/ingestion/runtime'

/** The most discovery pages one sweep reads; the database bounds each page, this bounds the sweep. */
const MAX_DISCOVERY_PAGES = 10_000

/**
 * Runs `visit` once for every Organization the database says has due work of `kind`. Discovery is
 * the db library's: unscoped, the only statement of its transaction (`deps.discover`), paged by
 * `resume_after` until it returns no row. `visit` runs afterwards, in the Organization's scope.
 * A failure for one Organization is reported and does not stop the others. Stops between
 * Organizations when `signal` aborts. Returns how many Organizations were visited.
 */
export async function forEachOrganization(
  deps: PipelineDeps,
  kind: WorkKind,
  signal: AbortSignal,
  visit: (organizationId: string) => Promise<void>
): Promise<number> {
  let after = ''
  let visited = 0
  for (let page = 0; page < MAX_DISCOVERY_PAGES && !signal.aborted; page++) {
    const { organizations, resumeAfter } = discoveredOrganizations(
      await deps.discover(kind, after, deps.env.DISCOVERY_BATCH)
    )
    for (const organizationId of organizations) {
      if (signal.aborted) {
        return visited
      }
      visited++
      try {
        await visit(organizationId)
      } catch (error) {
        reportWorkerError(deps, error, { worker: kind, organizationId })
      }
    }
    if (resumeAfter === null) {
      break
    }
    after = resumeAfter
  }
  return visited
}
