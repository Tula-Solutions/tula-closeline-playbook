import type { ErrorHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { internalErrorResponse } from '~/http/errors'
import { resolveRequestId } from '~/http/request-id'
import type { AppEnv } from '~/http/types'

/**
 * Hono hands only `Error` instances to `onError`; `throw 'x'` or `Promise.reject()` would escape.
 * This middleware catches whatever gets past, wraps a non-Error in one, and runs the normal error
 * handler on it, so every failure takes the same path: one report and the contract's 500 body.
 */
export function guard(handler: ErrorHandler<AppEnv>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    try {
      await next()
    } catch (thrown) {
      const error =
        thrown instanceof Error
          ? thrown
          : new Error('A value that is not an Error was thrown', { cause: thrown })
      try {
        return await handler(error, c)
      } catch {
        // The handler itself failed (for example an unserializable body): answer with plain bytes.
        return internalErrorResponse(c.get('requestId') ?? resolveRequestId(undefined))
      }
    }
  })
}
