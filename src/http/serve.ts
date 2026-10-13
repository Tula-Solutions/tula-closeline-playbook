import { type Container, reportSafely } from '~/container'
import { internalErrorResponse } from '~/http/errors'
import { resolveRequestId } from '~/http/request-id'

/** The part of the app that the server needs. */
type Fetcher = { fetch: (request: Request) => Response | Promise<Response> }

/**
 * How far above the app's limit `Bun.serve`'s own limit sits. A client that is just over the app's
 * limit then reaches the app and gets the contract's 413 with a request id, instead of Bun's bare
 * one. The app's check reads the `content-length` header, so it is advisory; the bytes are held
 * to the limit by the stream cut-off in the body-limit middleware (a body with no length) and by
 * Bun, which refuses anything over its own limit and never reads past a declared length.
 *
 * Accepted residual: a body larger than the app limit plus this margin never reaches the app. Bun
 * answers it with its own bare 413, with no body and no request id, whether the body is chunked
 * or declared. That response cannot carry the contract's error shape, and the cost of making it
 * do so (reading the excess) is the work the limit exists to avoid.
 */
export const BODY_LIMIT_MARGIN_BYTES = 65_536

/**
 * The options `Bun.serve` runs the app with. `development` follows `ENVIRONMENT`, never `NODE_ENV`.
 * The `error` hook is the last line of defence for a failure outside the app: it reports once and
 * answers with the contract's 500 body instead of Bun's own page.
 */
export function serveOptions(container: Container, app: Fetcher) {
  return {
    port: container.env.PORT,
    fetch: app.fetch,
    maxRequestBodySize: container.env.MAX_REQUEST_BODY_BYTES + BODY_LIMIT_MARGIN_BYTES,
    development: container.env.ENVIRONMENT === 'local',
    error: (error: unknown): Response => {
      const requestId = resolveRequestId(undefined)
      reportSafely(container, error, { requestId, method: 'UNKNOWN', path: 'UNKNOWN', status: 500 })
      return internalErrorResponse(requestId)
    },
  }
}
