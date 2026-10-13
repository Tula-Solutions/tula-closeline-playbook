import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'
import { livenessSchema, readinessSchema } from './schema'
import * as Health from './service'

const healthz = createRoute({
  method: 'get',
  path: '/healthz',
  tags: ['health'],
  summary: 'Liveness',
  description: 'Returns 200 while the process is up. It checks no dependency.',
  responses: {
    200: {
      description: 'The process is up.',
      content: { 'application/json': { schema: livenessSchema } },
    },
    500: errorResponse('Something went wrong on our side.'),
  },
})

const readyz = createRoute({
  method: 'get',
  path: '/readyz',
  tags: ['health'],
  summary: 'Readiness',
  description: 'Runs every dependency check, each with a short timeout; 503 when any fails.',
  responses: {
    200: {
      description: 'Every check passed.',
      content: { 'application/json': { schema: readinessSchema } },
    },
    503: {
      description: 'At least one check failed or timed out.',
      content: { 'application/json': { schema: readinessSchema } },
    },
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The health module's routes: `/healthz` and `/readyz`. */
export function createHealthRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()

  router.openapi(healthz, (c) => c.json(Health.liveness(), 200))

  router.openapi(readyz, async (c) => {
    const result = await Health.readiness(container)
    return result.status === 'ready' ? c.json(result, 200) : c.json(result, 503)
  })

  return router
}
