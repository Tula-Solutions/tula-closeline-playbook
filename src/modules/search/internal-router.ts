import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  formatId,
  organizationIdSchema,
  searchDocumentsRequestSchema,
  searchDocumentsResponseSchema,
  searchMomentsRequestSchema,
  searchMomentsResponseSchema,
  type UserId,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { internalAuth } from '~/http/internal-auth'
import { createRouter } from '~/http/router'
import { INTERNAL_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { INTERNAL_PREFIX } from '~/modules/document/internal-router'
import { failureResponses } from '~/modules/document/openapi'
import { searchDocuments } from './documents'
import * as Search from './service'

/** The user id an internal search runs as: no person is behind it, and the search reads nothing about one. */
const SERVICE_USER = formatId('usr', '00000000-0000-4000-8000-000000000000') as UserId

/** The public route's failures minus `auth.forbidden`: the shared secret has no roles to refuse. */
function withoutForbidden<T extends Record<number, unknown>>(responses: T): Omit<T, 403> {
  const { 403: _forbidden, ...rest } = responses
  return rest
}

const searchForAgent = createRoute({
  method: 'post',
  path: `${INTERNAL_PREFIX}/v1/playbook/search/documents`,
  tags: ['internal'],
  summary: "Find passages in an Organization's Playbook for the Inbound Agent",
  description:
    'Internal, called by the voice service with the shared secret (ADR 0013). Same request and answer as the public document search: at most 20 passages, best first, each with its score, file name, page and snippet (the Source citation). The Organization is the `X-Organization-Id` header, never the body. Answer within the search step deadlines; a stalled step is `server.unavailable` with `Retry-After`.',
  security: [{ [INTERNAL_SECURITY]: [] }],
  request: {
    headers: z.object({ 'x-organization-id': organizationIdSchema }),
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
    ...withoutForbidden(failureResponses('searchDocuments')),
  },
})

const searchMomentsForService = createRoute({
  method: 'post',
  path: `${INTERNAL_PREFIX}/v1/playbook/search/moments`,
  tags: ['internal'],
  summary: "Find similar Moments in an Organization's won Deals for another service",
  description:
    'Internal, called by core (grounded Drafts) and voice (Copilot cards) with the shared secret (ADR 0013). Same request and answer as the public Moment search. The Organization is the `X-Organization-Id` header, never the body.',
  security: [{ [INTERNAL_SECURITY]: [] }],
  request: {
    headers: z.object({ 'x-organization-id': organizationIdSchema }),
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
    ...withoutForbidden(failureResponses('searchMoments')),
  },
})

/**
 * The internal search route for the Inbound Agent (hub issue 461), behind the ADR 0013 shared
 * secret. The Organization comes from the `X-Organization-Id` header of the trusted caller, as in
 * core's internal routes; ADR 0013 has no signed service token yet (hub issue 417).
 */
export function createInternalSearchRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.use(`${INTERNAL_PREFIX}/v1/playbook/*`, internalAuth(container.env.INTERNAL_API_TOKENS))
  router.openapi(searchForAgent, async (c) => {
    const organizationId = c.req.valid('header')['x-organization-id']
    const context = {
      userId: SERVICE_USER,
      organizationId,
      role: 'rep' as const,
      requestId: c.get('requestId'),
    }
    return c.json(await searchDocuments(container, context, c.req.valid('json')), 200)
  })
  router.openapi(searchMomentsForService, async (c) => {
    // The shared secret has no role; Moment search needs the sales-history roles, so run as an Owner.
    const context = {
      userId: SERVICE_USER,
      organizationId: c.req.valid('header')['x-organization-id'],
      role: 'owner' as const,
      requestId: c.get('requestId'),
    }
    return c.json(await Search.searchMoments(container, context, c.req.valid('json')), 200)
  })
  return router
}
