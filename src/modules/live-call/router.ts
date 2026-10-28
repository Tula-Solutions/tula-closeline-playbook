import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'
import {
  listAwaitingDealCallsQuerySchema,
  listAwaitingDealCallsResponseSchema,
  PLAYBOOK_WRITE_ROLES,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { contractRoute, failureResponses } from '~/modules/document/openapi'
import { assertRole } from '~/modules/service-kit'
import * as LiveCalls from './service'

/** Refuses a role the route does not list with `auth.forbidden`, before anything else is done. */
const requireRole: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  assertRole(callerOf(c), PLAYBOOK_WRITE_ROLES)
  await next()
}

const listAwaitingDeal = createRoute({
  ...contractRoute('listAwaitingDealCalls'),
  middleware: requireRole,
  tags: ['calls'],
  summary: 'List ended platform Calls that wait for a Deal',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { query: listAwaitingDealCallsQuerySchema },
  responses: {
    200: {
      description: 'One page of Calls in the state awaiting_deal, oldest first.',
      content: { 'application/json': { schema: listAwaitingDealCallsResponseSchema } },
    },
    ...failureResponses('listAwaitingDealCalls'),
  },
})

/** The live-Call routes (spec M12), over the container. */
export function createLiveCallRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(listAwaitingDeal, async (c) =>
    c.json(
      await LiveCalls.listAwaitingDeal(
        container,
        { ...callerOf(c), requestId: c.get('requestId') },
        c.req.valid('query')
      ),
      200
    )
  )
  return router
}
