import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  confirmRightsRequestSchema,
  rightsStatusSchema,
  SALES_HISTORY_READ_ROLES,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { contractRoute, failureResponses } from '~/modules/document/openapi'
import { assertRole, type CallContext } from '~/modules/service-kit'
import * as Rights from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const tags = ['rights']

/** The caller of a request and its id, for the service. */
function contextOf(c: Context<AuthedEnv>): CallContext {
  return { ...callerOf(c), requestId: c.get('requestId') }
}

/** Refuses a role the routes do not list with `auth.forbidden`, before anything else is done. */
const requireRole: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  assertRole(callerOf(c), SALES_HISTORY_READ_ROLES)
  await next()
}

const read = createRoute({
  ...contractRoute('getRightsConfirmation'),
  middleware: requireRole,
  tags,
  summary: 'Read the rights confirmation',
  security,
  responses: {
    200: {
      description: 'The stored confirmation and whether it covers the current wording.',
      content: { 'application/json': { schema: rightsStatusSchema } },
    },
    ...failureResponses('getRightsConfirmation'),
  },
})

const record = createRoute({
  ...contractRoute('confirmRights'),
  middleware: requireRole,
  tags,
  summary: 'Confirm the rights wording',
  security,
  request: {
    body: {
      content: { 'application/json': { schema: confirmRightsRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'The confirmation as stored.',
      content: { 'application/json': { schema: rightsStatusSchema } },
    },
    ...failureResponses('confirmRights'),
  },
})

/** Builds the router for the rights confirmation. */
export function createRightsRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(read, async (c) => c.json(await Rights.get(container, contextOf(c)), 200))
  router.openapi(record, async (c) =>
    c.json(await Rights.confirm(container, contextOf(c), c.req.valid('json')), 200)
  )
  return router
}
