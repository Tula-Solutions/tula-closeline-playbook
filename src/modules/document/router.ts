import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  documentParamsSchema,
  documentSchema,
  ERRORS,
  idempotencyKeySchema,
  listDocumentsQuerySchema,
  listDocumentsResponseSchema,
  PLAYBOOK_READ_ROLES,
  PLAYBOOK_ROUTES,
  PLAYBOOK_WRITE_ROLES,
  type Role,
  UPLOAD_CONTENT_TYPE,
  UPLOAD_FILE_FIELD,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { capBody } from '~/http/body'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { uploadBodyLimit } from '~/http/limits'
import { idempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { createConcurrencyGate } from './limiter'
import { contractRoute, failureResponses } from './openapi'
import * as Documents from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const tags = ['documents']

/** The caller of a request and its id, for the service. */
function contextOf(c: Context<AuthedEnv>): Documents.CallContext {
  return { ...callerOf(c), requestId: c.get('requestId') }
}

/** Refuses a role the route does not list with `auth.forbidden`, before anything else is done. */
function requireRole(roles: readonly Role[]): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    Documents.assertRole(callerOf(c), roles)
    await next()
  }
}

const list = createRoute({
  ...contractRoute('listDocuments'),
  middleware: requireRole(PLAYBOOK_READ_ROLES),
  tags,
  summary: 'List documents',
  security,
  request: { query: listDocumentsQuerySchema },
  responses: {
    200: {
      description: 'One page of documents.',
      content: { 'application/json': { schema: listDocumentsResponseSchema } },
    },
    ...failureResponses('listDocuments'),
  },
})

const get = createRoute({
  ...contractRoute('getDocument'),
  middleware: requireRole(PLAYBOOK_READ_ROLES),
  tags,
  summary: 'Read a document',
  security,
  request: { params: documentParamsSchema },
  responses: {
    200: {
      description: 'The document.',
      content: { 'application/json': { schema: documentSchema } },
    },
    ...failureResponses('getDocument'),
  },
})

const remove = createRoute({
  ...contractRoute('deleteDocument'),
  middleware: requireRole(PLAYBOOK_WRITE_ROLES),
  tags,
  summary: 'Delete a document',
  security,
  request: { params: documentParamsSchema },
  responses: {
    200: {
      description: 'The document, deleted.',
      content: { 'application/json': { schema: documentSchema } },
    },
    ...failureResponses('deleteDocument'),
  },
})

const restore = createRoute({
  ...contractRoute('restoreDocument'),
  middleware: requireRole(PLAYBOOK_WRITE_ROLES),
  tags,
  summary: 'Restore a deleted document',
  security,
  request: { params: documentParamsSchema },
  responses: {
    200: {
      description: 'The document, restored or as it already was.',
      content: { 'application/json': { schema: documentSchema } },
    },
    ...failureResponses('restoreDocument'),
  },
})

/**
 * The upload is described here for the OpenAPI document and served by a plain handler below: it
 * must refuse a wrong role, a full instance and an over-size body before it reads the body, which
 * the validating route wrapper (that parses the form first) cannot do.
 */
const upload = createRoute({
  ...contractRoute('uploadDocument'),
  tags,
  summary: 'Upload a document',
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
              .meta({ type: 'string', format: 'binary', description: 'The file.' }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'The document was stored and queued for ingestion.',
      content: { 'application/json': { schema: documentSchema } },
    },
    200: {
      description:
        'The content matches a document the Organization has: that document, as stored (a deleted one restored, a failed one queued again).',
      content: { 'application/json': { schema: documentSchema } },
    },
    ...failureResponses('uploadDocument', ['server.unavailable']),
  },
})

/** The one `file` part of an upload, from a multipart body capped at the upload limit. */
async function readFilePart(c: Context<AuthedEnv>, maxBody: number): Promise<File> {
  const contentType = c.req.header('content-type') ?? ''
  if (!/^multipart\/form-data\s*(;|$)/i.test(contentType)) {
    throw domainError(ERRORS['request.unsupported_media_type'])
  }
  const capped = capBody(c.req.raw, maxBody)
  let form: Awaited<ReturnType<Request['formData']>>
  try {
    form = await capped.request.formData()
  } catch {
    throw domainError(capped.exceeded() ? ERRORS['request.too_large'] : ERRORS['request.invalid'])
  }
  const names = Array.from(form.keys())
  const part: unknown = form.get(UPLOAD_FILE_FIELD)
  if (names.length !== 1 || !(part instanceof File)) {
    throw domainError(ERRORS['request.invalid'])
  }
  return part
}

/** The `Idempotency-Key` header, or `undefined`; a malformed one is `request.invalid`. */
function idempotencyKeyOf(c: Context<AuthedEnv>): string | undefined {
  const header = c.req.header('idempotency-key')
  if (header === undefined) {
    return undefined
  }
  const parsed = idempotencyKeySchema.safeParse(header)
  if (!parsed.success) {
    throw domainError(ERRORS['request.invalid'])
  }
  return parsed.data
}

/**
 * The document routes under `/v1`. The upload runs in this order: the access token (the app), the
 * role, this instance's upload bound, the body size cap, the multipart parse, the file checks, the
 * idempotency key and the transaction (the service). When the instance already holds
 * `MAX_CONCURRENT_UPLOADS` uploads the answer is `server.unavailable` (503) with `Retry-After`,
 * because the contract has no code of its own for it, and the body is not read.
 */
export function createDocumentRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  const gate = createConcurrencyGate(container.env.MAX_CONCURRENT_UPLOADS)
  const maxBody = uploadBodyLimit(container.env)

  router.openAPIRegistry.registerPath(upload)
  router.post(
    PLAYBOOK_ROUTES.uploadDocument.path,
    requireRole(PLAYBOOK_WRITE_ROLES),
    async (_c, next) => {
      const release = gate.tryAcquire()
      if (release === undefined) {
        throw new RetryAfterError(ERRORS['server.unavailable'], 1)
      }
      try {
        await next()
      } finally {
        release()
      }
    },
    async (c) => {
      const key = idempotencyKeyOf(c)
      const part = await readFilePart(c, maxBody)
      const file = {
        fileName: part.name,
        declaredMediaType: part.type === '' ? null : part.type,
      }
      // Size and type first, from what the parser counted, before the bytes are copied out.
      Documents.assertUploadable({ ...file, sizeBytes: part.size }, container.env.MAX_UPLOAD_BYTES)
      const bytes = new Uint8Array(await part.arrayBuffer())
      const result = await Documents.upload(container, contextOf(c), {
        ...file,
        bytes,
        idempotencyKey: key,
      })
      return c.json(result.document, result.status)
    }
  )

  router.openapi(list, async (c) =>
    c.json(await Documents.list(container, contextOf(c), c.req.valid('query')), 200)
  )
  router.openapi(get, async (c) =>
    c.json(await Documents.get(container, contextOf(c), c.req.valid('param').documentId), 200)
  )
  router.openapi(remove, async (c) =>
    c.json(await Documents.remove(container, contextOf(c), c.req.valid('param').documentId), 200)
  )
  router.openapi(restore, async (c) =>
    c.json(await Documents.restore(container, contextOf(c), c.req.valid('param').documentId), 200)
  )

  return router
}
