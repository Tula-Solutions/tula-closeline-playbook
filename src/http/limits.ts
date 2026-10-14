import {
  MAX_DEAL_IMPORT_BYTES,
  MAX_TRANSCRIPT_BYTES,
  PLAYBOOK_ROUTES,
  SALES_HISTORY_ROUTES,
} from 'tula-closeline-contract'
import type { Env } from '~/env'

/** The prefix of every public route, which sits behind the access-token middleware. */
export const PUBLIC_PREFIX = '/v1'

/**
 * What a multipart envelope may add to the file inside it: the boundary lines and the part's
 * headers, for the one part an upload has. A body over the file limit plus this is
 * `request.too_large`; a file over the file limit but inside the envelope is `document.too_large`.
 */
export const UPLOAD_BODY_OVERHEAD_BYTES = 65_536

/** The method and path of the upload route, the only route with a body limit of its own. */
export const UPLOAD_ROUTE_KEY = `POST ${PUBLIC_PREFIX}${PLAYBOOK_ROUTES.uploadDocument.path}`

/** The body limit of the upload route: the file limit plus {@link UPLOAD_BODY_OVERHEAD_BYTES}. */
export function uploadBodyLimit(env: Pick<Env, 'MAX_UPLOAD_BYTES'>): number {
  return env.MAX_UPLOAD_BYTES + UPLOAD_BODY_OVERHEAD_BYTES
}

/** The method and path of the Deal import upload, which has a body limit of its own. */
export const IMPORT_UPLOAD_ROUTE_KEY = `POST ${PUBLIC_PREFIX}${SALES_HISTORY_ROUTES.uploadDealImport.path}`

/** The body limit of the Deal import upload: the contract's CSV limit plus {@link UPLOAD_BODY_OVERHEAD_BYTES}. */
export const IMPORT_BODY_LIMIT = MAX_DEAL_IMPORT_BYTES + UPLOAD_BODY_OVERHEAD_BYTES

/** The method and path of the Call upload, which has a body limit of its own. */
export const CALL_UPLOAD_ROUTE_KEY = `POST ${PUBLIC_PREFIX}${SALES_HISTORY_ROUTES.uploadCall.path}`

/**
 * The body limit of the Call upload: the Transcript limit plus {@link UPLOAD_BODY_OVERHEAD_BYTES}.
 * Recordings are not accepted yet, so a larger body is `request.too_large`.
 */
export const CALL_BODY_LIMIT = MAX_TRANSCRIPT_BYTES + UPLOAD_BODY_OVERHEAD_BYTES

/**
 * The body limit of each route that has one of its own, keyed by `METHOD /path`. Every other route
 * gets `MAX_REQUEST_BODY_BYTES`.
 */
export function routeBodyLimits(env: Pick<Env, 'MAX_UPLOAD_BYTES'>): ReadonlyMap<string, number> {
  return new Map([
    [UPLOAD_ROUTE_KEY, uploadBodyLimit(env)],
    [IMPORT_UPLOAD_ROUTE_KEY, IMPORT_BODY_LIMIT],
    [CALL_UPLOAD_ROUTE_KEY, CALL_BODY_LIMIT],
  ])
}

/**
 * The largest body any route accepts. `Bun.serve` has one limit for the whole process and cannot
 * give a route its own, so this is what Bun is told; the app's per-route limits then hold every
 * other route to its own.
 */
export function largestBodyLimit(
  env: Pick<Env, 'MAX_UPLOAD_BYTES' | 'MAX_REQUEST_BODY_BYTES'>
): number {
  return Math.max(env.MAX_REQUEST_BODY_BYTES, ...routeBodyLimits(env).values())
}
