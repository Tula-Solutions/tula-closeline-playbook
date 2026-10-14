import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  PLAYBOOK_READ_ROLES,
  SALES_HISTORY_READ_ROLES,
  searchDocumentsRequestSchema,
  searchDocumentsResponseSchema,
  searchMomentsRequestSchema,
  searchMomentsResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { contractRoute, failureResponses } from '~/modules/document/openapi'
import { assertRole, type CallContext } from '~/modules/service-kit'
import { searchDocuments } from './documents'
import * as Search from './service'

/** The caller of a request and its id, for the service. */
function contextOf(c: Context<AuthedEnv>): CallContext {
  return { ...callerOf(c), requestId: c.get('requestId') }
}

/** Refuses a role the route does not list with `auth.forbidden`, before the body is read. */
const requireSalesHistory: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  assertRole(callerOf(c), SALES_HISTORY_READ_ROLES)
  await next()
}

/** Refuses a role that cannot read the Playbook with `auth.forbidden`, before the body is read. */
const requirePlaybookReader: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  assertRole(callerOf(c), PLAYBOOK_READ_ROLES)
  await next()
}

const searchMoments = createRoute({
  ...contractRoute('searchMoments'),
  middleware: requireSalesHistory,
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

const searchDocumentsRoute = createRoute({
  ...contractRoute('searchDocuments'),
  middleware: requirePlaybookReader,
  tags: ['search'],
  summary: 'Find similar passages in Playbook documents',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: searchDocumentsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The best passages, best first, with the evidence.',
      content: { 'application/json': { schema: searchDocumentsResponseSchema } },
    },
    ...failureResponses('searchDocuments'),
  },
})

/** The search routes under `/v1`. It only reads: no idempotency key. */
export function createSearchRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(searchMoments, async (c) =>
    c.json(await Search.searchMoments(container, contextOf(c), c.req.valid('json')), 200)
  )
  router.openapi(searchDocumentsRoute, async (c) =>
    c.json(await searchDocuments(container, contextOf(c), c.req.valid('json')), 200)
  )
  return router
}
