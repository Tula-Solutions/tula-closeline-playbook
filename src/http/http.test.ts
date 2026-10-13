import { describe, expect, test } from 'bun:test'
import { createRoute, z } from '@hono/zod-openapi'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { errorBodySchema, requestIdSchema } from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import { createContainer } from '~/container'
import { createTestDeps } from '~/testing'
import { createBaseApp } from './base'
import { guard } from './guard'
import { requestId } from './request-id'
import type { AppEnv } from './types'

const echo = createRoute({
  method: 'post',
  path: '/echo',
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1) }) } },
    },
  },
  responses: {
    200: {
      description: 'The name back.',
      content: { 'application/json': { schema: z.object({ name: z.string() }) } },
    },
  },
})

const search = createRoute({
  method: 'get',
  path: '/search',
  request: { query: z.object({ q: z.string().min(2) }) },
  responses: {
    200: {
      description: 'The query back.',
      content: { 'application/json': { schema: z.object({ q: z.string() }) } },
    },
  },
})

function build() {
  const deps = createTestDeps()
  const app = createBaseApp(deps)

  app.get('/ok', (c) => c.json({ ok: true }))
  app.get('/log', (c) => {
    c.get('logger').info('handled')
    return c.json({ ok: true })
  })
  app.get('/app-error', () => {
    throw new AppError({
      code: 'team.not_found',
      status: 404,
      message: 'No such team.',
      details: { id: 'team_1' },
    })
  })
  app.get('/app-error-500', () => {
    throw new AppError({ code: 'billing.vendor_down', status: 502, message: 'Vendor is down.' })
  })
  app.get('/boom', () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2')
  })
  app.get('/http-400', () => {
    throw new HTTPException(400, { message: 'Malformed JSON in request body' })
  })
  app.get('/http-teapot', () => {
    throw new HTTPException(418, { message: 'short and stout' })
  })
  app.get('/internal-parse', () => {
    // A schema parse on data the handler fetched itself: a bug in the service, not in the request.
    z.object({ rowId: z.string() }).parse({ rowId: 1 })
    return new Response('unreachable')
  })
  app.get('/throw-string', () => {
    throw 'password=hunter2'
  })
  app.get('/reject-undefined', async () => {
    await Promise.reject()
    return new Response('unreachable')
  })
  app.get('/http/:status', (c) => {
    throw new HTTPException(Number(c.req.param('status')) as 400)
  })
  app.get('/app-error/:status', (c) => {
    throw new AppError({
      code: 'bench.weird',
      status: Number(c.req.param('status')),
      message: 'Not an error status.',
    })
  })
  app.get('/bigint-details', () => {
    throw new AppError({
      code: 'team.not_found',
      status: 404,
      message: 'No such team.',
      details: { n: 1n },
    })
  })
  app.openapi(echo, (c) => c.json({ name: c.req.valid('json').name }, 200))
  app.openapi(search, (c) => c.json({ q: c.req.valid('query').q }, 200))

  return { app, deps }
}

const REQUEST_ID = /^req_[0-9a-f]{32}$/

describe('request id', () => {
  test('a request without an id is given a minted one that is echoed', async () => {
    const { app } = build()

    const response = await app.request('/ok')

    const id = response.headers.get('x-request-id')
    expect(requestIdSchema.safeParse(id).success).toBe(true)
    expect(id).toMatch(REQUEST_ID)
  })

  test('two requests get two different ids', async () => {
    const { app } = build()

    const first = await app.request('/ok')
    const second = await app.request('/ok')

    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'))
  })

  test('a well-formed inbound id is kept and echoed', async () => {
    const { app } = build()
    const inbound = `req_${'ab12'.repeat(8)}`

    const response = await app.request('/ok', { headers: { 'x-request-id': inbound } })

    expect(response.headers.get('x-request-id')).toBe(inbound)
  })

  test.each([
    ['too short', 'req_abc'],
    ['wrong prefix', `usr_${'a'.repeat(32)}`],
    ['uppercase hex', `req_${'A'.repeat(32)}`],
    ['trailing text', `req_${'a'.repeat(32)} forged=1`],
    ['empty', ''],
  ])('a malformed inbound id (%s) is replaced, not echoed', async (_name, inbound) => {
    const { app } = build()

    const response = await app.request('/ok', { headers: { 'x-request-id': inbound } })

    const id = response.headers.get('x-request-id')
    expect(id).not.toBe(inbound)
    expect(id).toMatch(REQUEST_ID)
  })

  test('the handler logger carries the request id on every line', async () => {
    const { app, deps } = build()
    const inbound = `req_${'1'.repeat(32)}`

    await app.request('/log', { headers: { 'x-request-id': inbound } })

    const line = JSON.parse(deps.logLines.at(-1) ?? '{}')
    expect(line).toMatchObject({ msg: 'handled', requestId: inbound })
  })

  test('the id is echoed on error responses too', async () => {
    const { app } = build()
    const inbound = `req_${'2'.repeat(32)}`

    const response = await app.request('/boom', { headers: { 'x-request-id': inbound } })

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toBe(inbound)
  })
})

describe('body limit', () => {
  const limited = () => {
    const deps = createTestDeps({ env: { MAX_REQUEST_BODY_BYTES: '64' } })
    const app = createBaseApp(deps)
    app.post('/sink', async (c) => c.json({ bytes: (await c.req.text()).length }))
    return { app, deps }
  }

  test('a body over the limit is a 413 request.too_large in the contract body', async () => {
    const { app, deps } = limited()
    const body = 'x'.repeat(65)

    const response = await app.request('/sink', {
      method: 'POST',
      headers: { 'content-length': String(body.length) },
      body,
    })

    expect(response.status).toBe(413)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('request.too_large')
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID)
    expect(deps.reported).toHaveLength(0)
  })

  test('a streamed body over the limit is a 413 even without a length header', async () => {
    const { app } = limited()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(100)))
        controller.close()
      },
    })

    const response = await app.request('/sink', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    })

    expect(response.status).toBe(413)
  })

  test('a body within the limit reaches the handler', async () => {
    const { app } = limited()

    const response = await app.request('/sink', { method: 'POST', body: 'x'.repeat(64) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ bytes: 64 })
  })
})

describe('error handler', () => {
  test('an unexpected error is a generic 500 that leaks nothing', async () => {
    const { app } = build()

    const response = await app.request('/boom')

    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain('ECONNREFUSED')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('Error')
    const body = errorBodySchema.parse(JSON.parse(text))
    expect(body.error.code).toBe('server.internal')
  })

  test('an unexpected error goes to reportError with the request context', async () => {
    const { app, deps } = build()
    const inbound = `req_${'3'.repeat(32)}`

    await app.request('/boom?token=secret', { headers: { 'x-request-id': inbound } })

    expect(deps.reported).toHaveLength(1)
    expect(deps.reported[0]?.error).toBeInstanceOf(Error)
    expect(deps.reported[0]?.context).toEqual({
      requestId: inbound as never,
      method: 'GET',
      path: '/boom',
      status: 500,
    })
  })

  test('a failing reporter does not drop the response', async () => {
    const { app, deps } = build()
    deps.reportError = () => {
      throw new Error('tracker is down')
    }

    const response = await app.request('/boom')

    expect(response.status).toBe(500)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('server.internal')
  })

  test('an AppError keeps its code, status and details and is not reported', async () => {
    const { app, deps } = build()

    const response = await app.request('/app-error')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'team.not_found', message: 'No such team.', details: { id: 'team_1' } },
    })
    expect(deps.reported).toHaveLength(0)
  })

  test('an AppError with a server status is reported with that status', async () => {
    const { app, deps } = build()

    const response = await app.request('/app-error-500')

    expect(response.status).toBe(502)
    expect(deps.reported).toHaveLength(1)
    expect(deps.reported[0]?.context.status).toBe(502)
  })

  test('the log line for a 502 HTTPException names the exception, its status and the response status', async () => {
    const lines: string[] = []
    const deps = createTestDeps()
    const container = createContainer(deps.env, { logDestination: { write: (l) => lines.push(l) } })
    const app = createBaseApp(container)
    app.get('/upstream', () => {
      throw new HTTPException(502)
    })

    const response = await app.request('/upstream')

    expect(response.status).toBe(500)
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      msg: 'unhandled error',
      status: 500,
      error: { name: 'HTTPException', status: 502 },
    })
  })

  test('the log line for a 503 AppError carries its code and status', async () => {
    const lines: string[] = []
    const deps = createTestDeps()
    const container = createContainer(deps.env, { logDestination: { write: (l) => lines.push(l) } })
    const app = createBaseApp(container)
    app.get('/vendor', () => {
      throw new AppError({ code: 'billing.vendor_down', status: 503, message: 'Vendor is down.' })
    })

    await app.request('/vendor')

    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      status: 503,
      error: { name: 'AppError', code: 'billing.vendor_down', status: 503 },
    })
  })

  test('a body that fails its schema is a 400 request.invalid naming the field', async () => {
    const { app, deps } = build()

    const response = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })

    expect(response.status).toBe(400)
    const body = errorBodySchema.parse(await response.json())
    expect(body.error.code).toBe('request.invalid')
    expect(body.error.details).toEqual({
      issues: [expect.objectContaining({ path: 'name', code: 'too_small' })],
    })
    expect(deps.reported).toHaveLength(0)
  })

  test('malformed JSON is a 400 request.invalid', async () => {
    const { app, deps } = build()

    const response = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })

    expect(response.status).toBe(400)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('request.invalid')
    expect(deps.reported).toHaveLength(0)
  })

  test('a valid body reaches the handler', async () => {
    const { app } = build()

    const response = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'Acme' })
  })

  test('an HTTPException maps to the registry error for its status', async () => {
    const { app, deps } = build()

    const response = await app.request('/http-400')

    expect(response.status).toBe(400)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('request.invalid')
    expect(deps.reported).toHaveLength(0)
  })

  test.each([
    [400, 400, 'request.invalid'],
    [401, 401, 'auth.unauthenticated'],
    [403, 403, 'auth.forbidden'],
    [404, 404, 'request.not_found'],
    [405, 405, 'request.method_not_allowed'],
    [409, 409, 'request.conflict'],
    [413, 413, 'request.too_large'],
    [415, 415, 'request.unsupported_media_type'],
    [422, 422, 'request.unprocessable'],
    [429, 429, 'rate.limited'],
  ])('an HTTPException %p maps to %p %p and is not reported', async (from, status, code) => {
    const { app, deps } = build()

    const response = await app.request(`/http/${from}`)

    expect(response.status).toBe(status)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe(code)
    expect(deps.reported).toHaveLength(0)
  })

  test.each([418, 451])(
    'a client-error HTTPException %p keeps its status, is request.invalid and is not reported',
    async (status) => {
      const { app, deps } = build()

      const response = await app.request(`/http/${status}`)

      expect(response.status).toBe(status)
      const code = errorBodySchema.parse(await response.json()).error.code
      expect(code).toBe('request.invalid')
      expect(code).not.toBe('request.idempotency_key_reused')
      expect(deps.reported).toHaveLength(0)
    }
  )

  test.each([
    [500, 500, 'server.internal'],
    [502, 500, 'server.internal'],
    [503, 503, 'server.unavailable'],
    [504, 504, 'server.timeout'],
  ])('a server-error HTTPException %p is a %p %p and is reported', async (from, status, code) => {
    const { app, deps } = build()

    const response = await app.request(`/http/${from}`)

    expect(response.status).toBe(status)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe(code)
    expect(deps.reported).toHaveLength(1)
  })

  test.each([200, 204, 302])(
    'an AppError with the non-error status %p is a reported generic 500',
    async (status) => {
      const { app, deps } = build()

      const response = await app.request(`/app-error/${status}`)

      expect(response.status).toBe(500)
      const text = await response.text()
      expect(text).not.toContain('bench.weird')
      expect(errorBodySchema.parse(JSON.parse(text)).error.code).toBe('server.internal')
      expect(deps.reported).toHaveLength(1)
    }
  )

  test('an HTTPException with a status that is not an error status is a reported generic 500', async () => {
    const { app, deps } = build()

    const response = await app.request('/http/302')

    expect(response.status).toBe(500)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('server.internal')
    expect(deps.reported).toHaveLength(1)
  })

  test('if the error handler itself fails, the guard still answers with the plain 500 and the id', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', requestId(createTestDeps()))
    app.use(
      '*',
      guard(() => {
        throw new Error('handler is broken')
      })
    )
    app.get('/x', () => {
      throw 'not an error'
    })
    const inbound = `req_${'6'.repeat(32)}`

    const response = await app.request('/x', { headers: { 'x-request-id': inbound } })

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toBe(inbound)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('server.internal')
  })

  test('a schema parse failing inside a handler is a reported 500 that leaks no field names', async () => {
    const { app, deps } = build()

    const response = await app.request('/internal-parse')

    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain('rowId')
    expect(errorBodySchema.parse(JSON.parse(text)).error.code).toBe('server.internal')
    expect(deps.reported).toHaveLength(1)
  })

  test('a query that fails its schema is still a 400 request.invalid naming the field', async () => {
    const { app, deps } = build()

    const response = await app.request('/search?q=a')

    expect(response.status).toBe(400)
    const body = errorBodySchema.parse(await response.json())
    expect(body.error.code).toBe('request.invalid')
    expect(body.error.details).toEqual({
      issues: [expect.objectContaining({ path: 'q', code: 'too_small' })],
    })
    expect(deps.reported).toHaveLength(0)
  })

  test.each([
    ['throw', '/throw-string'],
    ['reject', '/reject-undefined'],
  ])(
    'a non-Error value from a handler (%s) is the normal 500 with the request id',
    async (_n, path) => {
      const { app, deps } = build()
      const inbound = `req_${'4'.repeat(32)}`

      const response = await app.request(path, { headers: { 'x-request-id': inbound } })

      expect(response.status).toBe(500)
      expect(response.headers.get('x-request-id')).toBe(inbound)
      const text = await response.text()
      expect(text).not.toContain('hunter2')
      expect(errorBodySchema.parse(JSON.parse(text)).error.code).toBe('server.internal')
      expect(deps.reported).toHaveLength(1)
      expect(deps.reported[0]?.error).toBeInstanceOf(Error)
      expect(deps.reported[0]?.context.requestId).toBe(inbound as never)
    }
  )

  test('a rejected promise from reportError does not become an unhandled rejection', async () => {
    const { app, deps } = build()
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    deps.reportError = (async () => {
      throw new Error('tracker is down')
    }) as never

    try {
      const response = await app.request('/boom')
      await Bun.sleep(20)

      expect(response.status).toBe(500)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  test('a response whose error body cannot be built is still a 500 carrying the request id', async () => {
    const { app, deps } = build()
    const inbound = `req_${'5'.repeat(32)}`

    const response = await app.request('/bigint-details', { headers: { 'x-request-id': inbound } })

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toBe(inbound)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('server.internal')
    expect(deps.reported).toHaveLength(1)
  })

  test('an unknown path is a 404 request.not_found in the contract body', async () => {
    const { app } = build()

    const response = await app.request('/nope')

    expect(response.status).toBe(404)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('request.not_found')
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID)
  })
})
