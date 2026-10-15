import { CALL_PURGE_RESET, DOCUMENT_PURGE_RESET } from 'tula-closeline-db'
import type { Run } from '~/adapters/postgres/processed-store'

/** The item whose purge gave up: a Call or a Document of one Organization. */
export type SpentPurgeTarget = { kind: 'call' | 'document'; id: string }

/**
 * Gives a spent purge (one that used every attempt) a fresh set of attempts, for the operator
 * script (hub issue 76, item 3). The db library's statements act only on a deleted item whose
 * attempts are used up, and bar its restore; the purge sweep then picks it up again. Returns
 * whether anything was reset, which is false for an item that is not stuck. Run it in the
 * Organization's scope; the service never calls it by itself, because a purge that gave up needs a
 * person to look at why first.
 */
export async function resetSpentPurge(
  run: Run,
  organizationId: string,
  target: SpentPurgeTarget
): Promise<boolean> {
  const statement = target.kind === 'call' ? CALL_PURGE_RESET : DOCUMENT_PURGE_RESET
  return (await run(statement, [organizationId, target.id])).rows.length > 0
}
