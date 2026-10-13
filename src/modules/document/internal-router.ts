import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  internalRemoveOrganizationDocumentsParamsSchema,
  internalRemoveOrganizationDocumentsResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { internalAuth } from '~/http/internal-auth'
import { requiredIdempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { INTERNAL_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { contractRoute, failureResponses } from './openapi'
import * as Documents from './service'

/** The path prefix every internal route of this service sits under. */
export const INTERNAL_PREFIX = '/internal'

const removeAll = createRoute({
  ...contractRoute('removeOrganizationDocuments'),
  tags: ['internal'],
  summary: 'Remove everything an Organization has in the Playbook',
  security: [{ [INTERNAL_SECURITY]: [] }],
  request: {
    headers: requiredIdempotencyKeyHeader(
      'Required. The same key returns the first answer once the Organization is removed.'
    ),
    params: internalRemoveOrganizationDocumentsParamsSchema,
  },
  responses: {
    200: {
      description: 'Nothing remains of the Organization in the Playbook.',
      content: {
        'application/json': { schema: internalRemoveOrganizationDocumentsResponseSchema },
      },
    },
    ...failureResponses('removeOrganizationDocuments', ['server.unavailable']),
  },
})

/**
 * The internal routes (ADR 0013), behind the shared secret and never behind the access-token
 * middleware. The guard is on `/internal/*` only, so mounting this router at the root leaves every
 * other route as it was. The Organization comes from the path and from nowhere else.
 *
 * Remove-all expects core to have stopped the Organization from signing in and uploading before it
 * calls. This service cannot stop a person who still holds a valid token: it only notices an upload
 * that lands after the erase (a document row is then left that was not erased), answers 503 and
 * erases it on the repeat. Cleanup messages are published eight at a time within a time budget;
 * those past the budget are left to the `cleanup_pending` sweep.
 */
export function createInternalDocumentRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.use(`${INTERNAL_PREFIX}/*`, internalAuth(container.env.INTERNAL_API_TOKENS))

  router.openapi(removeAll, async (c) => {
    const { organizationId } = c.req.valid('param')
    const key = c.req.valid('header')['idempotency-key']
    const result = await Documents.removeAll(container, organizationId, c.get('requestId'), key)
    return c.json(result, 200)
  })

  return router
}
