import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { type AuthedEnv, authenticate } from '~/http/auth'
import { createBaseApp } from '~/http/base'
import { createRouter } from '~/http/router'
import { registerSecuritySchemes } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { createHealthRouter } from '~/modules/health/router'
import { serveOpenApi } from '~/openapi'

/** The prefix of every public route, which sits behind the access-token middleware. */
export const PUBLIC_PREFIX = '/v1'

/**
 * Build the HTTP app from a container. Modules are mounted here as they are added. The public
 * routes under `/v1` sit behind the access-token middleware, which scopes every request to the
 * Organization in the verified token; the health routes sit outside it.
 */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createBaseApp(container)
  registerSecuritySchemes(app)

  app.route('/', createHealthRouter(container))

  const publicRoutes = createRouter<AuthedEnv>()
  publicRoutes.use('*', authenticate(container))
  // Playbook routes (hub issue 14) are mounted on publicRoutes here.
  app.route(PUBLIC_PREFIX, publicRoutes)

  serveOpenApi(app)

  return app
}
