import {
  DEAL_IMPORT_ERASE_BATCH,
  DEAL_IMPORT_LIST,
  DEAL_IMPORT_OBJECT_REMOVED,
  DEAL_IMPORT_PURGE_BATCH,
} from 'tula-closeline-db'
import type { Container } from '~/container'
import { transaction } from '~/modules/service-kit'
import { importObjectKey } from './keys'

/** What the erasure of imports needs from the container. */
export type EraseDeps = Pick<Container, 'scope' | 'objects' | 'logger'>

/** The imports one remove-all request erases and purges completely: a constant, so the request is bounded whatever the Organization holds. */
export const IMPORTS_ERASED_PER_REQUEST = 5

/** The report rows one purge step deletes; the database clamps it to 500. */
export const IMPORT_PURGE_STEP_ROWS = 500

/** The most purge steps for one import: its report holds at most 50,000 rows, so 100 steps, and a margin. */
export const IMPORT_PURGE_MAX_STEPS = 120

/**
 * Erases up to {@link IMPORTS_ERASED_PER_REQUEST} imports of the Organization completely, in the
 * order the db library gives: the CSV objects first (so a failing object store stops the request
 * before anything is erased), then, for one import at a time, `DEAL_IMPORT_ERASE_BATCH` (it ends an
 * active import and fences its job), the object removal recorded, and `DEAL_IMPORT_PURGE_BATCH`
 * in steps until the import row is gone. An erased import is no longer listed anywhere, so each one
 * is purged to the end within this request (at most {@link IMPORT_PURGE_MAX_STEPS} short
 * transactions); a crash in the middle strands it, which only a lister for erased imports in the
 * db library can recover. Returns the imports erased.
 */
export async function eraseImports(deps: EraseDeps, organizationId: string): Promise<number> {
  const listed = await transaction(
    deps,
    organizationId,
    async (run) => (await run(DEAL_IMPORT_LIST, [organizationId, 'infinity', '', 100])).rows
  )
  const removed = new Set<string>()
  for (const row of listed.slice(0, IMPORTS_ERASED_PER_REQUEST)) {
    const id = String(row.id)
    await deps.objects.delete(organizationId, importObjectKey(id))
    removed.add(id)
  }
  let erased = 0
  for (let round = 0; round < IMPORTS_ERASED_PER_REQUEST; round++) {
    const batch = await transaction(
      deps,
      organizationId,
      async (run) => (await run(DEAL_IMPORT_ERASE_BATCH, [organizationId, 1])).rows[0]
    )
    if (batch === undefined) {
      break
    }
    erased++
    const id = String(batch.id)
    if (batch.object_pending === true) {
      if (!removed.has(id)) {
        // An import that appeared after the listing: its object goes now, before the purge needs it recorded.
        await deps.objects.delete(organizationId, String(batch.object_key))
      }
      await transaction(deps, organizationId, (run) =>
        run(DEAL_IMPORT_OBJECT_REMOVED, [organizationId, id])
      )
    }
    let gone = false
    for (let step = 0; step < IMPORT_PURGE_MAX_STEPS && !gone; step++) {
      const purged = await transaction(
        deps,
        organizationId,
        async (run) =>
          (await run(DEAL_IMPORT_PURGE_BATCH, [organizationId, id, IMPORT_PURGE_STEP_ROWS])).rows[0]
      )
      gone = purged === undefined || purged.import_deleted === true
    }
    if (!gone) {
      deps.logger.error('the report of an erased import was not purged within one request', {
        organizationId,
        importId: id,
      })
    }
  }
  return erased
}
