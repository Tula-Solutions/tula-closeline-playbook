import { describe, expect, test } from 'bun:test'
import { errorBodySchema } from 'tula-closeline-contract'
import { createApp } from '~/app'
import { createTestDeps } from '~/testing'
import { BODY_LIMIT_MARGIN_BYTES, serveOptions } from './serve'

function optionsFor(env: Record<string, string>) {
  const deps = createTestDeps({ env })
  return { deps, options: serveOptions(deps, createApp(deps)) }
}

describe('Bun.serve options', () => {
  test('the error hook answers with the contract 500 body and a request id, and reports once', async () => {
    const { deps, options } = optionsFor({})

    const response = options.error(new Error('connect ECONNREFUSED password=hunter2'))

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toMatch(/^req_[0-9a-f]{32}$/)
    const text = await response.text()
    expect(text).not.toContain('hunter2')
    expect(errorBodySchema.parse(JSON.parse(text)).error.code).toBe('server.internal')
    expect(deps.reported).toHaveLength(1)
  })

  test.each([
    ['local', true],
    ['dev', false],
    ['staging', false],
    ['prod', false],
  ])('development mode in %s is %p, whatever NODE_ENV says', (environment, development) => {
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = environment === 'local' ? 'production' : 'development'
    try {
      expect(optionsFor({ ENVIRONMENT: environment }).options.development).toBe(development)
    } finally {
      process.env.NODE_ENV = before
    }
  })

  test('the request body size and port come from configuration', () => {
    const { options } = optionsFor({ MAX_REQUEST_BODY_BYTES: '2048', PORT: '4100' })

    expect(options.maxRequestBodySize).toBe(2048 + BODY_LIMIT_MARGIN_BYTES)
    expect(options.port).toBe(4100)
  })
})

describe('a real server and the body limit', () => {
  const LIMIT = 1024

  async function withServer<T>(run: (url: string, bodiesSeen: number[]) => Promise<T>): Promise<T> {
    const deps = createTestDeps({ env: { MAX_REQUEST_BODY_BYTES: String(LIMIT) } })
    const app = createApp(deps)
    app.post('/sink', async (c) => {
      const body = await c.req.text()
      bodiesSeen.push(body.length)
      return c.json({ bytes: body.length })
    })
    const bodiesSeen: number[] = []
    const server = Bun.serve({ ...serveOptions(deps, app), port: 0 })
    try {
      return await run(`http://127.0.0.1:${server.port}`, bodiesSeen)
    } finally {
      await server.stop(true)
    }
  }

  test('a body just over the app limit gets the contract 413 with a request id, not the server own', async () => {
    await withServer(async (url, bodiesSeen) => {
      const response = await fetch(`${url}/sink`, { method: 'POST', body: 'x'.repeat(LIMIT + 1) })

      expect(response.status).toBe(413)
      expect(errorBodySchema.parse(await response.json()).error.code).toBe('request.too_large')
      expect(response.headers.get('x-request-id')).toMatch(/^req_[0-9a-f]{32}$/)
      expect(bodiesSeen).toEqual([])
    })
  })

  test('a body far over the limit never reaches the handler', async () => {
    await withServer(async (url, bodiesSeen) => {
      const response = await fetch(`${url}/sink`, {
        method: 'POST',
        body: 'x'.repeat(BODY_LIMIT_MARGIN_BYTES * 4),
      }).catch(() => undefined)

      expect(response === undefined || response.status === 413).toBe(true)
      expect(bodiesSeen).toEqual([])
    })
  })

  test('a body larger than its small, lying content-length is cut off, not fully read', async () => {
    await withServer(async (url, bodiesSeen) => {
      const { hostname, port } = new URL(url)
      const huge = 'x'.repeat(BODY_LIMIT_MARGIN_BYTES * 4)
      const replies: string[] = []
      const closed = Promise.withResolvers<void>()
      const socket = await Bun.connect({
        hostname,
        port: Number(port),
        socket: {
          data: (_s, chunk) => void replies.push(chunk.toString()),
          close: () => closed.resolve(),
          error: () => closed.resolve(),
        },
      })
      socket.write(
        `POST /sink HTTP/1.1\r\nhost: x\r\ncontent-length: 5\r\nconnection: close\r\n\r\n${huge}`
      )
      await Promise.race([closed.promise, Bun.sleep(1_000)])
      socket.end()

      expect(bodiesSeen.every((bytes) => bytes <= 5)).toBe(true)
      expect(replies.join('')).not.toContain(`"bytes":${huge.length}`)
    })
  })
})
