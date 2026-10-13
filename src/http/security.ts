import type { OpenAPIHono } from '@hono/zod-openapi'
import type { AppEnv } from '~/http/types'

/** The OpenAPI security scheme of every public route: the auth service's access token. */
export const PUBLIC_SECURITY = 'accessToken'

/** Registers the security scheme the public routes name, once, on the app that will serve them. */
export function registerSecuritySchemes(app: OpenAPIHono<AppEnv>): void {
  app.openAPIRegistry.registerComponent('securitySchemes', PUBLIC_SECURITY, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'An access token issued by the auth service.',
  })
}
