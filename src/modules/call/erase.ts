import { CALL_ERASE_BATCH } from 'tula-closeline-db'
import { inTransaction } from '~/modules/ingestion/runtime'
import { type CallPurgeDeps, purgeCalls } from './purge'

/** The Calls one erase batch bars from restore; the database clamps it. */
export const CALL_ERASE_BATCH_SIZE = 100

/** The batches, and the purge passes, one remove-all request runs: a constant, so a request is bounded whatever the Organization holds. */
export const CALL_ERASE_BATCHES_PER_REQUEST = 5

/**
 * Takes the Organization's Calls toward their end, in the db library's order: up to
 * {@link CALL_ERASE_BATCHES_PER_REQUEST} batches bar the Calls from restore, make them due for purge
 * and cancel their jobs (their objects are removed at once, best effort), then the same number of
 * purge passes remove each Call's vectors, objects and row. A Call whose job lease has not ended
 * stays for the next request or the purge sweep. This must finish before the Deals are erased: a Deal
 * a Call refers to cannot be deleted. Returns the Calls purged.
 */
export async function eraseCalls(
  deps: CallPurgeDeps,
  organizationId: string,
  actor: string
): Promise<number> {
  for (let batch = 0; batch < CALL_ERASE_BATCHES_PER_REQUEST; batch++) {
    const erased = await inTransaction(
      deps,
      organizationId,
      async (run) =>
        (await run(CALL_ERASE_BATCH, [organizationId, CALL_ERASE_BATCH_SIZE, actor])).rows
    )
    for (const row of erased) {
      for (const key of [row.object_key, row.transcript_key]) {
        if (typeof key === 'string') {
          try {
            await deps.objects.delete(organizationId, key)
          } catch {
            // The purge removes the whole prefix again; a failure here costs nothing.
          }
        }
      }
    }
    if (erased.length === 0) {
      break
    }
  }
  let purged = 0
  const never = new AbortController().signal
  for (let pass = 0; pass < CALL_ERASE_BATCHES_PER_REQUEST; pass++) {
    const result = await purgeCalls(deps, organizationId, never)
    purged += result.purged
    if (result.purged + result.deferred === 0) {
      break
    }
  }
  return purged
}
