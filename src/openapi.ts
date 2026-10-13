import type { OpenAPIHono } from '@hono/zod-openapi'
import type { AppEnv } from '~/http/types'
import { SERVICE, VERSION } from '~/info'

/** The path the app serves its OpenAPI document at. */
export const OPENAPI_PATH = '/openapi.json'

const config = {
  openapi: '3.1.0',
  info: { title: SERVICE, version: VERSION },
} as const

/** Serves the OpenAPI 3.1 document at {@link OPENAPI_PATH}. */
export function serveOpenApi(app: OpenAPIHono<AppEnv>): void {
  app.doc31(OPENAPI_PATH, config)
}

/** Builds the OpenAPI 3.1 document for every route registered on `app`. */
export function buildOpenApiDocument(app: OpenAPIHono<AppEnv>) {
  return app.getOpenAPI31Document(config)
}
