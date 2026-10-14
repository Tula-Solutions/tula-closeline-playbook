import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  SALES_HISTORY_READ_ROLES,
  searchMomentsRequestSchema,
  searchMomentsResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { contractRoute, failureResponses } from '~/modules/document/openapi'
import { assertRole, type CallContext } from '~/modules/service-kit'
import * as Search from './service'

/** The caller of a request and its id, for the service. */
function contextOf(c: Context<AuthedEnv>): CallContext {
  return { ...callerOf(c), requestId: c.get('requestId') }
}

/** Refuses a role the route does not list with `auth.forbidden`, before the body is read. */
const requireRole: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  assertRole(callerOf(c), SALES_HISTORY_READ_ROLES)
  await next()
}

const searchMoments = createRoute({
  ...contractRoute('searchMoments'),
  middleware: requireRole,
  tags: ['search'],
  summary: 'Find similar Moments in won Deals',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: searchMomentsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The best matches, best first, with the evidence.',
      content: { 'application/json': { schema: searchMomentsResponseSchema } },
    },
    ...failureResponses('searchMoments'),
  },
})

/** The search route under `/v1`. It only reads: no idempotency key. */
export function createSearchRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(searchMoments, async (c) =>
    c.json(await Search.searchMoments(container, contextOf(c), c.req.valid('json')), 200)
  )
  return router
}
