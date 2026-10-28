import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { type AuthedEnv, authenticate } from '~/http/auth'
import { createBaseApp } from '~/http/base'
import { PUBLIC_PREFIX } from '~/http/limits'
import { createRouter } from '~/http/router'
import { registerSecuritySchemes } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { createCallRouter } from '~/modules/call/router'
import { createDealRouter } from '~/modules/deal/router'
import { createDealImportRouter } from '~/modules/deal-import/router'
import { createInternalDocumentRouter } from '~/modules/document/internal-router'
import { createDocumentRouter } from '~/modules/document/router'
import { createHealthRouter } from '~/modules/health/router'
import { createLiveCallRouter } from '~/modules/live-call/router'
import { createRightsRouter } from '~/modules/rights/router'
import { createInternalSearchRouter } from '~/modules/search/internal-router'
import { createSearchRouter } from '~/modules/search/router'
import { createSuggestionRouter } from '~/modules/suggestion/router'
import { serveOpenApi } from '~/openapi'

/** The prefix of every public route, which sits behind the access-token middleware. */
export { PUBLIC_PREFIX }

/**
 * Build the HTTP app from a container. Modules are mounted here as they are added. The public
 * routes under `/v1` sit behind the access-token middleware, which scopes every request to the
 * Organization in the verified token; the health routes sit outside it.
 */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createBaseApp(container)
  registerSecuritySchemes(app)

  app.route('/', createHealthRouter(container))
  app.route('/', createInternalDocumentRouter(container))
  app.route('/', createInternalSearchRouter(container))

  const publicRoutes = createRouter<AuthedEnv>()
  publicRoutes.use('*', authenticate(container))
  publicRoutes.route('/', createDocumentRouter(container))
  publicRoutes.route('/', createDealRouter(container))
  publicRoutes.route('/', createDealImportRouter(container))
  // Before the Call router: `/calls/awaiting-deal` would otherwise match `/calls/{callId}`.
  publicRoutes.route('/', createLiveCallRouter(container))
  publicRoutes.route('/', createCallRouter(container))
  publicRoutes.route('/', createRightsRouter(container))
  publicRoutes.route('/', createSearchRouter(container))
  publicRoutes.route('/', createSuggestionRouter(container))
  app.route(PUBLIC_PREFIX, publicRoutes)

  serveOpenApi(app)

  return app
}
