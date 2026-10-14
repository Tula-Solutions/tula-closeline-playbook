import {
  type ConfirmRightsRequest,
  CURRENT_RIGHTS_WORDING_VERSION,
  type RightsStatus,
  rightsConfirmationSchema,
  rightsStatusSchema,
  rightsWordingFor,
  SALES_HISTORY_READ_ROLES,
} from 'tula-closeline-contract'
import { RIGHTS_CONFIRM, RIGHTS_GET } from 'tula-closeline-db'
import type { Container } from '~/container'
import { parsePgTimestamp } from '~/modules/document/schema'
import { assertRole, type CallContext, failure, transaction } from '~/modules/service-kit'

/** What the rights service needs from the container. */
export type RightsDeps = Pick<Container, 'scope'>

/** The stored confirmation as the contract's, or null when the row is missing. */
function confirmationOf(row: Record<string, unknown> | undefined) {
  if (row === undefined) {
    return null
  }
  const at = parsePgTimestamp(String(row.confirmed_at))
  return rightsConfirmationSchema.parse({
    wordingVersion: row.wording_version,
    confirmedByUserId: row.confirmed_by,
    confirmedAt: at?.toISOString(),
  })
}

/** The status the contract describes: confirmed only when the stored version is the current one. */
function statusOf(row: Record<string, unknown> | undefined): RightsStatus {
  const confirmation = confirmationOf(row)
  const current = CURRENT_RIGHTS_WORDING_VERSION
  return rightsStatusSchema.parse({
    currentWordingVersion: current,
    currentWording: rightsWordingFor(current),
    confirmation,
    confirmed: confirmation !== null && confirmation.wordingVersion === current,
  })
}

/** Reads the Organization's rights confirmation and whether it covers the current wording. */
export async function get(deps: RightsDeps, context: CallContext): Promise<RightsStatus> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  const row = await transaction(
    deps,
    context.organizationId,
    async (run) => (await run(RIGHTS_GET, [context.organizationId])).rows[0]
  )
  return statusOf(row)
}

/**
 * Records that the caller confirmed the current wording. A version other than the current one is
 * `rights.version_outdated`. Repeating it keeps the first record (idempotent by end state); who
 * and when come from the token and the database clock, never from the body.
 */
export async function confirm(
  deps: RightsDeps,
  context: CallContext,
  request: ConfirmRightsRequest
): Promise<RightsStatus> {
  assertRole(context, SALES_HISTORY_READ_ROLES)
  if (request.wordingVersion !== CURRENT_RIGHTS_WORDING_VERSION) {
    throw failure('rights.version_outdated')
  }
  const row = await transaction(
    deps,
    context.organizationId,
    async (run) =>
      (await run(RIGHTS_CONFIRM, [context.organizationId, context.userId, request.wordingVersion]))
        .rows[0]
  )
  return statusOf(row)
}
