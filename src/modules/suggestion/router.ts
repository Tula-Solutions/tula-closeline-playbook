import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  acceptSuggestionRequestSchema,
  learningSettingsSchema,
  listSuggestionsQuerySchema,
  listSuggestionsResponseSchema,
  rejectSuggestionRequestSchema,
  SALES_HISTORY_READ_ROLES,
  suggestionSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { idempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { contractRoute, failureResponses } from '~/modules/document/openapi'
import { idempotencyKeyOf } from '~/modules/document/router'
import { assertRole, type CallContext } from '~/modules/service-kit'
import { suggestionParamsSchema } from './schema'
import * as Suggestions from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const tags = ['suggestions']

/** The caller of a request and its id, for the service. */
function contextOf(c: Context<AuthedEnv>): CallContext {
  return { ...callerOf(c), requestId: c.get('requestId') }
}

/** Refuses a role the routes do not list with `auth.forbidden`, before anything else is done. */
const requireRole: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  assertRole(callerOf(c), SALES_HISTORY_READ_ROLES)
  await next()
}

const suggestionResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: suggestionSchema } },
})

const list = createRoute({
  ...contractRoute('listSuggestions'),
  middleware: requireRole,
  tags,
  summary: 'List Suggestions',
  security,
  request: { query: listSuggestionsQuerySchema },
  responses: {
    200: {
      description: 'One page of Suggestions, newest first.',
      content: { 'application/json': { schema: listSuggestionsResponseSchema } },
    },
    ...failureResponses('listSuggestions'),
  },
})

const get = createRoute({
  ...contractRoute('getSuggestion'),
  middleware: requireRole,
  tags,
  summary: 'Read a Suggestion',
  security,
  request: { params: suggestionParamsSchema },
  responses: {
    200: suggestionResponse('The Suggestion.'),
    ...failureResponses('getSuggestion'),
  },
})

const accept = createRoute({
  ...contractRoute('acceptSuggestion'),
  middleware: requireRole,
  tags,
  summary: 'Accept a Suggestion, optionally with its text edited',
  security,
  request: {
    params: suggestionParamsSchema,
    headers: idempotencyKeyHeader('Makes a repeat of this accept return the first answer.'),
    body: {
      required: true,
      content: { 'application/json': { schema: acceptSuggestionRequestSchema } },
    },
  },
  responses: {
    200: suggestionResponse('The accepted Suggestion.'),
    ...failureResponses('acceptSuggestion'),
  },
})

const reject = createRoute({
  ...contractRoute('rejectSuggestion'),
  middleware: requireRole,
  tags,
  summary: 'Reject a Suggestion',
  security,
  request: {
    params: suggestionParamsSchema,
    headers: idempotencyKeyHeader('Makes a repeat of this reject return the first answer.'),
    body: {
      required: true,
      content: { 'application/json': { schema: rejectSuggestionRequestSchema } },
    },
  },
  responses: {
    200: suggestionResponse('The rejected Suggestion.'),
    ...failureResponses('rejectSuggestion'),
  },
})

const getLearning = createRoute({
  ...contractRoute('getLearningSettings'),
  middleware: requireRole,
  tags,
  summary: 'Read whether the Organization learns from Agent Moments',
  security,
  responses: {
    200: {
      description: 'The switch.',
      content: { 'application/json': { schema: learningSettingsSchema } },
    },
    ...failureResponses('getLearningSettings'),
  },
})

const setLearning = createRoute({
  ...contractRoute('setLearningSettings'),
  middleware: requireRole,
  tags,
  summary: 'Set whether the Organization learns from Agent Moments',
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: learningSettingsSchema } } },
  },
  responses: {
    200: {
      description: 'The switch as set.',
      content: { 'application/json': { schema: learningSettingsSchema } },
    },
    ...failureResponses('setLearningSettings'),
  },
})

/** The Suggestion and learning-switch routes under `/v1`: Owner and Admin only, the Organization from the verified token only. */
export function createSuggestionRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(list, async (c) =>
    c.json(await Suggestions.list(container, contextOf(c), c.req.valid('query')), 200)
  )
  router.openapi(get, async (c) =>
    c.json(await Suggestions.get(container, contextOf(c), c.req.valid('param').suggestionId), 200)
  )
  router.openapi(accept, async (c) =>
    c.json(
      await Suggestions.accept(
        container,
        contextOf(c),
        c.req.valid('param').suggestionId,
        c.req.valid('json'),
        idempotencyKeyOf(c)
      ),
      200
    )
  )
  router.openapi(reject, async (c) =>
    c.json(
      await Suggestions.reject(
        container,
        contextOf(c),
        c.req.valid('param').suggestionId,
        idempotencyKeyOf(c)
      ),
      200
    )
  )
  router.openapi(getLearning, async (c) =>
    c.json(await Suggestions.getLearning(container, contextOf(c)), 200)
  )
  router.openapi(setLearning, async (c) =>
    c.json(await Suggestions.setLearning(container, contextOf(c), c.req.valid('json')), 200)
  )
  return router
}
