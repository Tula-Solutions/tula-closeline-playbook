import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  callParamsSchema,
  callSchema,
  ERRORS,
  listCallsQuerySchema,
  listCallsResponseSchema,
  PLAYBOOK_WRITE_ROLES,
  type Role,
  SALES_HISTORY_READ_ROLES,
  SALES_HISTORY_ROUTES,
  setCallRepRequestSchema,
  UPLOAD_CONTENT_TYPE,
  UPLOAD_FILE_FIELD,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { CALL_BODY_LIMIT } from '~/http/limits'
import { idempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { uploadGatesOf } from '~/modules/document/limiter'
import { contractRoute, failureResponses } from '~/modules/document/openapi'
import { idempotencyKeyOf, readUploadForm } from '~/modules/document/router'
import { assertRole, type CallContext } from '~/modules/service-kit'
import * as Calls from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const tags = ['calls']

/** The text fields a Call upload may carry beside its file. */
const UPLOAD_TEXT_FIELDS: ReadonlySet<string> = new Set(['dealId', 'rep'])

/** The caller of a request and its id, for the service. */
function contextOf(c: Context<AuthedEnv>): CallContext {
  return { ...callerOf(c), requestId: c.get('requestId') }
}

/** Refuses a role not in `roles` with `auth.forbidden`, before anything else is done. */
function requireRole(roles: readonly Role[]): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    assertRole(callerOf(c), roles)
    await next()
  }
}

/**
 * The upload is described here for the OpenAPI document and served by a plain handler below, as
 * the document upload is: it must refuse a wrong role, a full instance and an over-size body before
 * it reads the body.
 */
const upload = createRoute({
  ...contractRoute('uploadCall'),
  tags,
  summary: 'Upload a Call Transcript',
  security,
  request: {
    headers: idempotencyKeyHeader(
      'A client-chosen key. The same key with the same file returns the first answer and stores ' +
        'nothing again; the same key with another file is request.idempotency_key_reused (422); ' +
        'the same key while the first request is still running is ' +
        'request.idempotency_in_progress (409, with Retry-After).'
    ),
    body: {
      required: true,
      content: {
        [UPLOAD_CONTENT_TYPE]: {
          schema: z.object({
            [UPLOAD_FILE_FIELD]: z
              .string()
              .meta({ type: 'string', format: 'binary', description: 'The Transcript file.' }),
            dealId: z.string().meta({ description: 'The customer deal id; created open if new.' }),
            rep: z
              .string()
              .optional()
              .meta({ description: 'JSON text naming the Rep: {"by":"speaker","label":"..."}.' }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'The Transcript was stored and queued for processing.',
      content: { 'application/json': { schema: callSchema } },
    },
    200: {
      description:
        'The content matches a Call the Organization has: that Call, as stored (a deleted one restored, a failed one queued again).',
      content: { 'application/json': { schema: callSchema } },
    },
    ...failureResponses('uploadCall', ['server.unavailable', 'server.timeout', 'rate.limited']),
  },
})

const list = createRoute({
  ...contractRoute('listCalls'),
  middleware: requireRole(SALES_HISTORY_READ_ROLES),
  tags,
  summary: 'List Calls',
  security,
  request: { query: listCallsQuerySchema },
  responses: {
    200: {
      description: 'One page of Calls, newest first.',
      content: { 'application/json': { schema: listCallsResponseSchema } },
    },
    ...failureResponses('listCalls'),
  },
})

const get = createRoute({
  ...contractRoute('getCall'),
  middleware: requireRole(SALES_HISTORY_READ_ROLES),
  tags,
  summary: 'Read a Call',
  security,
  request: { params: callParamsSchema },
  responses: {
    200: {
      description: 'The Call.',
      content: { 'application/json': { schema: callSchema } },
    },
    ...failureResponses('getCall'),
  },
})

const del = createRoute({
  ...contractRoute('deleteCall'),
  middleware: requireRole(PLAYBOOK_WRITE_ROLES),
  tags,
  summary: 'Delete a Call',
  security,
  request: { params: callParamsSchema },
  responses: {
    200: {
      description: 'The Call in state deleted, with its purge time.',
      content: { 'application/json': { schema: callSchema } },
    },
    ...failureResponses('deleteCall'),
  },
})

const restoreRoute = createRoute({
  ...contractRoute('restoreCall'),
  middleware: requireRole(PLAYBOOK_WRITE_ROLES),
  tags,
  summary: 'Restore a deleted Call',
  security,
  request: { params: callParamsSchema },
  responses: {
    200: {
      description: 'The Call, processing again, or as it is when it was not deleted.',
      content: { 'application/json': { schema: callSchema } },
    },
    ...failureResponses('restoreCall'),
  },
})

const setRep = createRoute({
  ...contractRoute('setCallRep'),
  middleware: requireRole(PLAYBOOK_WRITE_ROLES),
  tags,
  summary: 'Pick or change the Rep of a Call',
  security,
  request: {
    params: callParamsSchema,
    body: { required: true, content: { 'application/json': { schema: setCallRepRequestSchema } } },
  },
  responses: {
    200: {
      description:
        'The Call, processing while its Moments are rebuilt, or as it is when the Rep is unchanged.',
      content: { 'application/json': { schema: callSchema } },
    },
    ...failureResponses('setCallRep'),
  },
})

/** A text field of the upload form, or `undefined` when absent; a file in its place is `request.invalid`. */
function textField(
  form: Awaited<ReturnType<Request['formData']>>,
  name: string
): string | undefined {
  const value = form.get(name)
  if (value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw domainError(ERRORS['request.invalid'])
  }
  return value
}

/**
 * The Call routes under `/v1`. The upload runs in this order: the access token (the app), the
 * role (Owner or Admin), this instance's upload places (shared with the other uploads), the body
 * cap, the multipart parse, the size and type check, the idempotency key and the transaction (the
 * service). A full instance is `server.unavailable` (503) and an Organization over its share is
 * `rate.limited` (429), both with `Retry-After`; a body not complete within `UPLOAD_BODY_TIMEOUT_MS`
 * is `server.timeout` (504). Only Transcripts are accepted now; a Recording is `call.unsupported_type`.
 */
export function createCallRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  const { gate, shares } = uploadGatesOf(container, container.env.MAX_CONCURRENT_UPLOADS)

  router.openAPIRegistry.registerPath(upload)
  router.post(
    SALES_HISTORY_ROUTES.uploadCall.path,
    requireRole(PLAYBOOK_WRITE_ROLES),
    async (c, next) => {
      const releaseGate = gate.tryAcquire()
      if (releaseGate === undefined) {
        throw new RetryAfterError(ERRORS['server.unavailable'], 1)
      }
      const releaseShare = shares.tryAcquire(callerOf(c).organizationId)
      if (releaseShare === undefined) {
        releaseGate()
        throw new RetryAfterError(ERRORS['rate.limited'], 1)
      }
      try {
        await next()
      } finally {
        releaseShare()
        releaseGate()
      }
    },
    async (c) => {
      const key = idempotencyKeyOf(c)
      const form = await readUploadForm(c, CALL_BODY_LIMIT, container.env.UPLOAD_BODY_TIMEOUT_MS)
      const file: unknown = form.get(UPLOAD_FILE_FIELD)
      const names = Array.from(form.keys())
      if (
        !(file instanceof File) ||
        names.length !== new Set(names).size ||
        names.some((name) => name !== UPLOAD_FILE_FIELD && !UPLOAD_TEXT_FIELDS.has(name))
      ) {
        throw domainError(ERRORS['request.invalid'])
      }
      const fields = { dealId: textField(form, 'dealId'), rep: textField(form, 'rep') }
      // Size and type first, from what the parser counted, before the bytes are copied out.
      Calls.checkCallUpload(
        {
          fileName: file.name,
          declaredMediaType: file.type === '' ? null : file.type,
          sizeBytes: file.size,
        },
        fields
      )
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = await Calls.upload(container, contextOf(c), {
        fileName: file.name,
        declaredMediaType: file.type === '' ? null : file.type,
        bytes,
        ...fields,
        idempotencyKey: key,
      })
      return c.json(result.call, result.status)
    }
  )

  router.openapi(list, async (c) =>
    c.json(await Calls.list(container, contextOf(c), c.req.valid('query')), 200)
  )
  router.openapi(get, async (c) =>
    c.json(await Calls.get(container, contextOf(c), c.req.valid('param').callId), 200)
  )
  router.openapi(del, async (c) =>
    c.json(await Calls.remove(container, contextOf(c), c.req.valid('param').callId), 200)
  )
  router.openapi(restoreRoute, async (c) =>
    c.json(await Calls.restore(container, contextOf(c), c.req.valid('param').callId), 200)
  )
  router.openapi(setRep, async (c) =>
    c.json(
      await Calls.setRep(container, contextOf(c), c.req.valid('param').callId, c.req.valid('json')),
      200
    )
  )
  return router
}
