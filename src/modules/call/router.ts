import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import {
  callParamsSchema,
  callSchema,
  checkCallFile,
  ERRORS,
  listCallsQuerySchema,
  listCallsResponseSchema,
  MAX_TRANSCRIPT_BYTES,
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
import { capBody } from '~/http/body'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { CALL_BODY_LIMIT } from '~/http/limits'
import { boundaryOf, MultipartError, readMultipart, readTextPart } from '~/http/multipart'
import { idempotencyKeyHeader } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { uploadGatesOf } from '~/modules/document/limiter'
import { contractRoute, failureResponses } from '~/modules/document/openapi'
import { idempotencyKeyOf } from '~/modules/document/router'
import { assertRole, type CallContext, failure } from '~/modules/service-kit'
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
  summary: 'Upload a Call Transcript or Recording',
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
            [UPLOAD_FILE_FIELD]: z.string().meta({
              type: 'string',
              format: 'binary',
              description:
                'The Transcript or Recording file. A Recording is streamed to storage (500 MB at most), ' +
                'so `dealId` and `rep` must come before `file` in the form.',
            }),
            dealId: z.string().meta({ description: 'The customer deal id; created open if new.' }),
            rep: z
              .string()
              .optional()
              .meta({
                description:
                  'JSON text naming the Rep: {"by":"speaker","label":"..."} for a Transcript; ' +
                  '{"by":"channel","channel":"left"|"right"} for a per-side Recording; absent for a ' +
                  'Recording whose Rep is picked after transcription.',
              }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'The Transcript or Recording was stored and queued.',
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

/** The longest a text field of the upload form may be, in bytes: a deal id or a Rep choice is far shorter. */
const MAX_FIELD_BYTES = 8192

/** The most parts an upload form may have: the file, the deal id and the Rep, with one spare to refuse. */
const MAX_PARTS = 4

/** Reads a Transcript's bytes to the end, refusing one over the Transcript limit with `call.too_large`. */
async function collectTranscript(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.byteLength
    if (size > MAX_TRANSCRIPT_BYTES) {
      throw failure('call.too_large')
    }
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * Reads the upload form as a stream and stores the file. The form's fields are read as they come; a
 * Transcript (judged by the file's name) is collected, at most {@link MAX_TRANSCRIPT_BYTES}, and
 * stored once the form is read to the end, so its fields may come in any order. A Recording is never
 * collected: the file part streams straight to the object store, so `dealId` (and `rep`) must come
 * before it and nothing may follow it. The body is cut off at the Call upload's limit and at a
 * deadline (`UPLOAD_BODY_TIMEOUT_MS` until a Recording starts, then `RECORDING_BODY_TIMEOUT_MS`).
 */
async function readAndStoreUpload(
  container: Container,
  c: Context<AuthedEnv>,
  idempotencyKey: string | undefined
): Promise<Calls.CallUploadResult> {
  const contentType = c.req.header('content-type') ?? ''
  if (!/^multipart\/form-data\s*(;|$)/i.test(contentType)) {
    throw domainError(ERRORS['request.unsupported_media_type'])
  }
  const boundary = boundaryOf(contentType)
  if (boundary === undefined || c.req.raw.body === null) {
    throw domainError(ERRORS['request.invalid'])
  }
  const deadline = new AbortController()
  let timer = setTimeout(() => deadline.abort(), container.env.UPLOAD_BODY_TIMEOUT_MS)
  let rate: ReturnType<typeof setInterval> | undefined
  const capped = capBody(c.req.raw, CALL_BODY_LIMIT, deadline.signal)
  const context = contextOf(c)
  try {
    const parts = readMultipart(capped.request.body as ReadableStream<Uint8Array>, boundary)
    const fields: { dealId: string | undefined; rep: string | undefined } = {
      dealId: undefined,
      rep: undefined,
    }
    const seen = new Set<string>()
    let transcript:
      | { fileName: string; declaredMediaType: string | null; bytes: Uint8Array }
      | undefined
    for (let count = 0; ; count++) {
      const part = await parts.next()
      if (part === undefined) {
        break
      }
      if (
        count >= MAX_PARTS ||
        seen.has(part.name) ||
        (part.name !== UPLOAD_FILE_FIELD && !UPLOAD_TEXT_FIELDS.has(part.name))
      ) {
        throw domainError(ERRORS['request.invalid'])
      }
      seen.add(part.name)
      if (part.name !== UPLOAD_FILE_FIELD) {
        if (part.fileName !== undefined) {
          throw domainError(ERRORS['request.invalid'])
        }
        fields[part.name as 'dealId' | 'rep'] = await readTextPart(part, MAX_FIELD_BYTES)
        continue
      }
      if (part.fileName === undefined) {
        throw domainError(ERRORS['request.invalid'])
      }
      const declaredMediaType =
        part.contentType === undefined || part.contentType === '' ? null : part.contentType
      const kind = checkCallFile({ fileName: part.fileName, declaredMediaType, sizeBytes: 1 })
      if (!kind.ok) {
        throw failure(kind.code)
      }
      if (kind.kind === 'transcript') {
        transcript = {
          fileName: part.fileName,
          declaredMediaType,
          bytes: await collectTranscript(part.body),
        }
        continue
      }
      // A Recording: its fields must already be known, and nothing may follow the file.
      if (fields.dealId === undefined) {
        throw domainError(ERRORS['request.invalid'])
      }
      clearTimeout(timer)
      timer = setTimeout(() => deadline.abort(), container.env.RECORDING_BODY_TIMEOUT_MS)
      const file = part
      // A sender that trickles is cut off: each window must carry the minimum rate's worth of bytes.
      let windowBytes = 0
      const windowMs = container.env.RECORDING_RATE_WINDOW_MS
      const minPerWindow = (container.env.RECORDING_MIN_BYTES_PER_SECOND * windowMs) / 1000
      rate = setInterval(() => {
        if (windowBytes < minPerWindow) {
          deadline.abort()
        }
        windowBytes = 0
      }, windowMs)
      const body = (async function* () {
        for await (const chunk of file.body) {
          windowBytes += chunk.byteLength
          yield chunk
        }
        clearInterval(rate)
        if ((await parts.next()) !== undefined) {
          throw domainError(ERRORS['request.invalid'])
        }
      })()
      return await Calls.uploadRecording(container, context, {
        fileName: part.fileName,
        declaredMediaType,
        body,
        dealId: fields.dealId,
        rep: fields.rep,
        idempotencyKey,
        signal: deadline.signal,
      })
    }
    if (transcript === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
    // Size and type first, as before the bytes are used.
    Calls.checkCallUpload(
      {
        fileName: transcript.fileName,
        declaredMediaType: transcript.declaredMediaType,
        sizeBytes: transcript.bytes.byteLength,
      },
      fields
    )
    return await Calls.upload(container, context, {
      ...transcript,
      ...fields,
      idempotencyKey,
    })
  } catch (error) {
    if (capped.timedOut()) {
      throw domainError(ERRORS['server.timeout'])
    }
    if (capped.exceeded()) {
      throw domainError(ERRORS['request.too_large'])
    }
    if (error instanceof MultipartError) {
      throw domainError(ERRORS['request.invalid'])
    }
    throw error
  } finally {
    clearTimeout(timer)
    clearInterval(rate)
  }
}

/**
 * The Call routes under `/v1`. The upload runs in this order: the access token (the app), the
 * role (Owner or Admin), this instance's upload places (shared with the other uploads), the body
 * cap, the multipart parse, the size and type check, the idempotency key and the transaction (the
 * service). A full instance is `server.unavailable` (503) and an Organization over its share is
 * `rate.limited` (429), both with `Retry-After`; a body not complete within `UPLOAD_BODY_TIMEOUT_MS`
 * is `server.timeout` (504). A Transcript is held whole (5 MB at most); a Recording streams to the
 * object store (500 MB at most) and is never held; see {@link readAndStoreUpload}.
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
      const result = await readAndStoreUpload(container, c, key)
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
