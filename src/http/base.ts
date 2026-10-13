import type { OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { ERRORS } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { createErrorHandler, notFoundHandler, respond } from '~/http/errors'
import { guard } from '~/http/guard'
import { requestId } from '~/http/request-id'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'

/**
 * The app with the request id middleware, the outermost error guard, the body size limit, the
 * error handler and the 404 handler, and no routes yet.
 */
export function createBaseApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createRouter()
  const handler = createErrorHandler(container)

  app.use('*', requestId(container))
  app.use('*', guard(handler))
  app.use(
    '*',
    bodyLimit({
      maxSize: container.env.MAX_REQUEST_BODY_BYTES,
      onError: (c) => respond(c, ERRORS['request.too_large']),
    })
  )
  app.onError(handler)
  app.notFound(notFoundHandler)

  return app
}
