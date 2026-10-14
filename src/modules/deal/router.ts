import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  dealParamsSchema,
  dealSchema,
  listDealsQuerySchema,
  listDealsResponseSchema,
  lookupDealRequestSchema,
  SALES_HISTORY_READ_ROLES,
  setDealOutcomeRequestSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { contractRoute, failureResponses } from '~/modules/document/openapi'
import { assertRole, type CallContext } from '~/modules/service-kit'
import * as Deals from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const tags = ['deals']

/** The caller of a request and its id, for the service. */
function contextOf(c: Context<AuthedEnv>): CallContext {
  return { ...callerOf(c), requestId: c.get('requestId') }
}

/** Refuses a role the routes do not list with `auth.forbidden`, before anything else is done. */
const requireRole: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  assertRole(callerOf(c), SALES_HISTORY_READ_ROLES)
  await next()
}

const list = createRoute({
  ...contractRoute('listDeals'),
  middleware: requireRole,
  tags,
  summary: 'List Deals',
  security,
  request: { query: listDealsQuerySchema },
  responses: {
    200: {
      description: 'One page of Deals, newest first.',
      content: { 'application/json': { schema: listDealsResponseSchema } },
    },
    ...failureResponses('listDeals'),
  },
})

const get = createRoute({
  ...contractRoute('getDeal'),
  middleware: requireRole,
  tags,
  summary: 'Read a Deal',
  security,
  request: { params: dealParamsSchema },
  responses: {
    200: { description: 'The Deal.', content: { 'application/json': { schema: dealSchema } } },
    ...failureResponses('getDeal'),
  },
})

const lookup = createRoute({
  ...contractRoute('lookupDeal'),
  middleware: requireRole,
  tags,
  summary: "Look a Deal up by the customer's deal id",
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: lookupDealRequestSchema } },
    },
  },
  responses: {
    200: { description: 'The Deal.', content: { 'application/json': { schema: dealSchema } } },
    ...failureResponses('lookupDeal'),
  },
})

const setOutcome = createRoute({
  ...contractRoute('setDealOutcome'),
  middleware: requireRole,
  tags,
  summary: "Set a Deal's Outcome",
  security,
  request: {
    params: dealParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: setDealOutcomeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The Deal, with its Outcome as set (unchanged for a repeat).',
      content: { 'application/json': { schema: dealSchema } },
    },
    ...failureResponses('setDealOutcome'),
  },
})

/** The Deal routes under `/v1`: Owner and Admin only, the Organization from the verified token only. */
export function createDealRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(list, async (c) =>
    c.json(await Deals.list(container, contextOf(c), c.req.valid('query')), 200)
  )
  // `/deals/lookup` is registered before the id route is reachable by it: its path is distinct (POST).
  router.openapi(lookup, async (c) =>
    c.json(await Deals.lookup(container, contextOf(c), c.req.valid('json')), 200)
  )
  router.openapi(get, async (c) =>
    c.json(await Deals.get(container, contextOf(c), c.req.valid('param').dealRecordId), 200)
  )
  router.openapi(setOutcome, async (c) =>
    c.json(
      await Deals.setOutcome(
        container,
        contextOf(c),
        c.req.valid('param').dealRecordId,
        c.req.valid('json')
      ),
      200
    )
  )
  return router
}
