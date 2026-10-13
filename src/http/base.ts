import type { OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ERRORS } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { declaredLengthLimit } from '~/http/body'
import { createErrorHandler, notFoundHandler, respond } from '~/http/errors'
import { guard } from '~/http/guard'
import { routeBodyLimits } from '~/http/limits'
import { requestId } from '~/http/request-id'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'

/**
 * The app with the request id middleware, the outermost error guard, the body size limit (one for the upload route alone), the
 * error handler and the 404 handler, and no routes yet.
 */
export function createBaseApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createRouter()
  const handler = createErrorHandler(container)

  app.use('*', requestId(container))
  app.use('*', guard(handler))
  // One limit for every route, and a larger one for the upload route alone (hub issue 14).
  const limiterFor = (maxSize: number) =>
    bodyLimit({ maxSize, onError: (c) => respond(c, ERRORS['request.too_large']) })
  const standard: MiddlewareHandler<AppEnv> = limiterFor(container.env.MAX_REQUEST_BODY_BYTES)
  // A route with a limit of its own does not buffer a body of unknown length here, before it has
  // authenticated the caller: this checks the declared length and the route caps what it reads.
  const own = new Map<string, MiddlewareHandler<AppEnv>>(
    [...routeBodyLimits(container.env)].map(([route, maxSize]) => [
      route,
      declaredLengthLimit(maxSize),
    ])
  )
  app.use('*', (c, next) => (own.get(`${c.req.method} ${c.req.path}`) ?? standard)(c, next))
  app.onError(handler)
  app.notFound(notFoundHandler)

  return app
}
