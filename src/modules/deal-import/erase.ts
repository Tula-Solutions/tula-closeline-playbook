import {
  DEAL_IMPORT_ERASE_BATCH,
  DEAL_IMPORT_LIST_ERASED,
  DEAL_IMPORT_OBJECT_REMOVED,
  DEAL_IMPORT_PURGE_BATCH,
} from 'tula-closeline-db'
import type { Container } from '~/container'
import { transaction } from '~/modules/service-kit'

/** What the erasure of imports needs from the container. */
export type EraseDeps = Pick<Container, 'scope' | 'objects' | 'logger'>

/** The imports one remove-all request erases and purges completely: a constant, so the request is bounded whatever the Organization holds. */
export const IMPORTS_ERASED_PER_REQUEST = 5

/** The report rows one purge step deletes; the database clamps it to 500. */
export const IMPORT_PURGE_STEP_ROWS = 500

/** The most purge steps for one import: its report holds at most 50,000 rows, so 100 steps, and a margin. */
export const IMPORT_PURGE_MAX_STEPS = 120

/** The imports listed per page when finishing erased ones; the database clamps it to 100. */
const ERASED_PAGE = 100

/** One import the erase has marked: its id, its file's key, and whether the file is not yet recorded removed. */
type Erased = { id: string; objectKey: string; objectPending: boolean }

/**
 * Takes an erased import to its end: the CSV removed (when it is not recorded removed), that
 * recorded, then the report purged in steps until the import row is gone. Every step can be run
 * again after a crash, because `DEAL_IMPORT_LIST_ERASED` shows the import until its row is gone.
 */
async function finishErased(
  deps: EraseDeps,
  organizationId: string,
  erased: Erased
): Promise<void> {
  if (erased.objectPending) {
    await deps.objects.delete(organizationId, erased.objectKey)
    await transaction(deps, organizationId, (run) =>
      run(DEAL_IMPORT_OBJECT_REMOVED, [organizationId, erased.id])
    )
  }
  let gone = false
  for (let step = 0; step < IMPORT_PURGE_MAX_STEPS && !gone; step++) {
    const purged = await transaction(
      deps,
      organizationId,
      async (run) =>
        (await run(DEAL_IMPORT_PURGE_BATCH, [organizationId, erased.id, IMPORT_PURGE_STEP_ROWS]))
          .rows[0]
    )
    gone = purged === undefined || purged.import_deleted === true
  }
  if (!gone) {
    // Still listed as erased, so the next request carries on.
    deps.logger.warn('the report of an erased import was not purged within one request', {
      organizationId,
      importId: erased.id,
    })
  }
}

/**
 * Takes up to {@link IMPORTS_ERASED_PER_REQUEST} imports of the Organization to their end, in the
 * db library's order: the erased imports an earlier request left unfinished first (listed by
 * `DEAL_IMPORT_LIST_ERASED`), then `DEAL_IMPORT_ERASE_BATCH` one import at a time (it ends an active
 * import and fences its job), each finished at once. A failure at any step leaves the import listed
 * as erased, so the next request finishes it; nothing is lost with a crash. Returns the imports
 * finished.
 */
export async function eraseImports(deps: EraseDeps, organizationId: string): Promise<number> {
  let finished = 0
  let after = ''
  while (finished < IMPORTS_ERASED_PER_REQUEST) {
    const page = await transaction(
      deps,
      organizationId,
      async (run) => (await run(DEAL_IMPORT_LIST_ERASED, [organizationId, after, ERASED_PAGE])).rows
    )
    for (const row of page) {
      if (finished >= IMPORTS_ERASED_PER_REQUEST) {
        return finished
      }
      await finishErased(deps, organizationId, {
        id: String(row.id),
        objectKey: String(row.object_key),
        objectPending: row.object_pending === true,
      })
      finished++
    }
    const last = page.at(-1)
    if (last === undefined || page.length < ERASED_PAGE) {
      break
    }
    after = String(last.id)
  }
  while (finished < IMPORTS_ERASED_PER_REQUEST) {
    const batch = await transaction(
      deps,
      organizationId,
      async (run) => (await run(DEAL_IMPORT_ERASE_BATCH, [organizationId, 1])).rows[0]
    )
    if (batch === undefined) {
      break
    }
    await finishErased(deps, organizationId, {
      id: String(batch.id),
      objectKey: String(batch.object_key),
      objectPending: batch.object_pending === true,
    })
    finished++
  }
  return finished
}
