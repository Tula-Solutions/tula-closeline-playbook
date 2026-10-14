import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  DEAL_IMPORT_FILE_FIELD,
  dealImportParamsSchema,
  dealImportSchema,
  ERRORS,
  listDealImportRowsQuerySchema,
  listDealImportRowsResponseSchema,
  listDealImportsQuerySchema,
  listDealImportsResponseSchema,
  SALES_HISTORY_READ_ROLES,
  SALES_HISTORY_ROUTES,
  UPLOAD_CONTENT_TYPE,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { RetryAfterError } from '~/http/domain-error'
import { IMPORT_BODY_LIMIT } from '~/http/limits'
import { idempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { uploadGatesOf } from '~/modules/document/limiter'
import { contractRoute, failureResponses } from '~/modules/document/openapi'
import { idempotencyKeyOf, readFilePart } from '~/modules/document/router'
import { assertRole, type CallContext } from '~/modules/service-kit'
import * as Imports from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const tags = ['deal-imports']

/** The caller of a request and its id, for the service. */
function contextOf(c: Context<AuthedEnv>): CallContext {
  return { ...callerOf(c), requestId: c.get('requestId') }
}

/** Refuses a role the routes do not list with `auth.forbidden`, before anything else is done. */
const requireRole: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  assertRole(callerOf(c), SALES_HISTORY_READ_ROLES)
  await next()
}

/**
 * The upload is described here for the OpenAPI document and served by a plain handler below, as
 * the document upload is: it must refuse a wrong role, a full instance and an over-size body before
 * it reads the body.
 */
const upload = createRoute({
  ...contractRoute('uploadDealImport'),
  tags,
  summary: 'Upload a Deal import CSV',
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
            [DEAL_IMPORT_FILE_FIELD]: z
              .string()
              .meta({ type: 'string', format: 'binary', description: 'The CSV file.' }),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description: 'The CSV was stored and the import queued; it is processed in the background.',
      content: { 'application/json': { schema: dealImportSchema } },
    },
    ...failureResponses('uploadDealImport', [
      'server.unavailable',
      'server.timeout',
      'rate.limited',
    ]),
  },
})

const list = createRoute({
  ...contractRoute('listDealImports'),
  middleware: requireRole,
  tags,
  summary: 'List Deal imports',
  security,
  request: { query: listDealImportsQuerySchema },
  responses: {
    200: {
      description: 'One page of imports, newest first.',
      content: { 'application/json': { schema: listDealImportsResponseSchema } },
    },
    ...failureResponses('listDealImports'),
  },
})

const get = createRoute({
  ...contractRoute('getDealImport'),
  middleware: requireRole,
  tags,
  summary: 'Read a Deal import',
  security,
  request: { params: dealImportParamsSchema },
  responses: {
    200: {
      description: 'The import.',
      content: { 'application/json': { schema: dealImportSchema } },
    },
    ...failureResponses('getDealImport'),
  },
})

const rows = createRoute({
  ...contractRoute('listDealImportRows'),
  middleware: requireRole,
  tags,
  summary: 'Read the report of a Deal import',
  security,
  request: { params: dealImportParamsSchema, query: listDealImportRowsQuerySchema },
  responses: {
    200: {
      description: 'One page of the report, in CSV order.',
      content: { 'application/json': { schema: listDealImportRowsResponseSchema } },
    },
    ...failureResponses('listDealImportRows'),
  },
})

/**
 * The Deal import routes under `/v1`. The upload runs in this order: the access token (the app),
 * the role, this instance's upload places (shared with document uploads), the body cap, the
 * multipart parse, the size and type check, the header check on the first 8192 characters, the
 * idempotency key and the transaction (the service). A full instance is `server.unavailable` (503)
 * and an Organization over its share is `rate.limited` (429), both with `Retry-After`; a body not
 * complete within `UPLOAD_BODY_TIMEOUT_MS` is `server.timeout` (504).
 */
export function createDealImportRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  const { gate, shares } = uploadGatesOf(container, container.env.MAX_CONCURRENT_UPLOADS)

  router.openAPIRegistry.registerPath(upload)
  router.post(
    SALES_HISTORY_ROUTES.uploadDealImport.path,
    requireRole,
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
      const part = await readFilePart(
        c,
        IMPORT_BODY_LIMIT,
        container.env.UPLOAD_BODY_TIMEOUT_MS,
        DEAL_IMPORT_FILE_FIELD
      )
      const file = {
        fileName: part.name,
        declaredMediaType: part.type === '' ? null : part.type,
      }
      // Size and type first, from what the parser counted, before the bytes are copied out.
      Imports.assertImportable({ ...file, sizeBytes: part.size })
      const bytes = new Uint8Array(await part.arrayBuffer())
      const result = await Imports.upload(container, contextOf(c), {
        ...file,
        bytes,
        idempotencyKey: key,
      })
      return c.json(result.dealImport, result.status)
    }
  )

  router.openapi(list, async (c) =>
    c.json(await Imports.list(container, contextOf(c), c.req.valid('query')), 200)
  )
  router.openapi(get, async (c) =>
    c.json(await Imports.get(container, contextOf(c), c.req.valid('param').importId), 200)
  )
  router.openapi(rows, async (c) =>
    c.json(
      await Imports.listRows(
        container,
        contextOf(c),
        c.req.valid('param').importId,
        c.req.valid('query')
      ),
      200
    )
  )
  return router
}
