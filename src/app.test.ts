import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { type AuthedEnv, authenticate, callerOf } from '~/http/auth'
import { createApp, PUBLIC_PREFIX } from './app'
import { SERVICE } from './info'
import { buildOpenApiDocument } from './openapi'
import {
  createTestApp,
  createTestDeps,
  newOrganizationId,
  newUserId,
  type TestIdentity,
} from './testing'

type ServedDocument = {
  openapi: string
  info: { title: string }
  paths: Record<string, { get: { responses: Record<string, unknown> } }>
  components?: { securitySchemes?: Record<string, unknown> }
}

describe('the booted app', () => {
  test('serves health, naming the service and the three shared libraries', async () => {
    const response = await createApp(createTestDeps()).request('/healthz')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      service: SERVICE,
      libraries: ['tula-closeline-contract', 'tula-closeline-db', 'tula-closeline-kit'],
    })
  })

  test('serves its OpenAPI document describing every route, the error body and the token scheme', async () => {
    const response = await createApp(createTestDeps()).request('/openapi.json')

    expect(response.status).toBe(200)
    const document = (await response.json()) as ServedDocument
    expect(document.openapi).toBe('3.1.0')
    expect(document.info.title).toBe(SERVICE)
    expect(Object.keys(document.paths).sort()).toEqual([
      '/healthz',
      '/internal/playbook/organizations/{organizationId}/remove-all',
      '/readyz',
      '/v1/playbook/deal-imports',
      '/v1/playbook/deal-imports/{importId}',
      '/v1/playbook/deal-imports/{importId}/rows',
      '/v1/playbook/deals',
      '/v1/playbook/deals/lookup',
      '/v1/playbook/deals/{dealRecordId}',
      '/v1/playbook/deals/{dealRecordId}/outcome',
      '/v1/playbook/documents',
      '/v1/playbook/documents/{documentId}',
      '/v1/playbook/documents/{documentId}/restore',
      '/v1/playbook/rights-confirmation',
    ])
    expect(document.paths['/healthz']?.get.responses['500']).toBeDefined()
    expect(document.paths['/readyz']?.get.responses['503']).toBeDefined()
    expect(JSON.stringify(document.paths['/healthz']?.get.responses['500'])).toContain('code')
    expect(document.components?.securitySchemes).toHaveProperty('accessToken')
    expect(document.components?.securitySchemes).toHaveProperty('internalSecret')
  })

  test('the document written by the script is the document the app serves', async () => {
    const app = createApp(createTestDeps())

    const served = await (await app.request('/openapi.json')).json()

    expect(JSON.parse(JSON.stringify(buildOpenApiDocument(app)))).toEqual(served)
  })

  test('health and the document need no token, and a path that does not exist is a plain 404', async () => {
    const app = createApp(createTestDeps())

    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/readyz')).status).toBe(200)
    expect((await app.request('/openapi.json')).status).toBe(200)
    const missing = await app.request('/nowhere')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'request.not_found' } })
  })
})

const identity = (): TestIdentity => ({
  userId: newUserId(),
  organizationId: newOrganizationId(),
  role: 'admin',
})

type Body = { error?: { code: string; message: string } }

describe('every request outside health is scoped to the token', () => {
  const path = `${PUBLIC_PREFIX}/anything`

  test('a request with no token is refused with auth.unauthenticated', async () => {
    const { app } = await createTestApp()

    const response = await app.request(path)

    expect(response.status).toBe(401)
    expect(((await response.json()) as Body).error?.code).toBe('auth.unauthenticated')
  })

  test.each([
    ['a token that is not a token', 'Bearer not-a-token'],
    ['a header that is not a bearer header', 'Basic dXNlcjpwYXNz'],
    ['a token with three parts and no meaning', 'Bearer aaa.bbb.ccc'],
    ['an empty bearer token', 'Bearer '],
  ])('%s is refused with the contract auth code', async (_name, authorization) => {
    const { app } = await createTestApp()

    const response = await app.request(path, { headers: { authorization } })

    expect(response.status).toBe(401)
    expect(((await response.json()) as Body).error?.code).toMatch(/^auth\./)
  })

  test('a token signed by a key the service does not trust is refused as invalid', async () => {
    const { app, bearerFromUnknownKey } = await createTestApp()

    const response = await app.request(path, { headers: await bearerFromUnknownKey(identity()) })

    expect(response.status).toBe(401)
    expect(((await response.json()) as Body).error?.code).toBe('auth.token_invalid')
  })

  test.each([
    ['another audience', { audience: 'someone-else' }],
    ['another issuer', { issuer: 'https://evil.test' }],
  ])(
    'a token signed by the trusted key but for %s is refused as invalid',
    async (_name, options) => {
      const { app, bearerWith } = await createTestApp()

      const response = await app.request(path, { headers: await bearerWith(identity(), options) })

      expect(response.status).toBe(401)
      expect(((await response.json()) as Body).error?.code).toBe('auth.token_invalid')
    }
  )

  test('a token that has expired is refused as expired', async () => {
    const { app, bearer, deps } = await createTestApp()
    const headers = await bearer(identity())
    await deps.time.advance(60 * 60 * 1000)

    const response = await app.request(path, { headers })

    expect(response.status).toBe(401)
    expect(((await response.json()) as Body).error?.code).toBe('auth.token_expired')
  })

  test('a valid token passes the check, so only the missing route answers', async () => {
    const { app, bearer } = await createTestApp()

    const response = await app.request(path, { headers: await bearer(identity()) })

    expect(response.status).toBe(404)
    expect(((await response.json()) as Body).error?.code).toBe('request.not_found')
  })

  test('a refusal says nothing about why a signature failed beyond its code', async () => {
    const { app, bearerFromUnknownKey } = await createTestApp()
    const headers = await bearerFromUnknownKey(identity())

    const text = await (await app.request(path, { headers })).text()

    expect(text).not.toContain(headers.authorization.slice('Bearer '.length))
  })
})

describe('the Organization comes from the verified token only', () => {
  async function probe() {
    const test = await createTestApp()
    const app = new Hono<AuthedEnv>()
    app.use('*', authenticate(test.deps))
    app.get('/whoami', (c) => c.json(callerOf(c)))
    return { ...test, probe: app }
  }

  test('a caller of one Organization is that Organization whatever else the request names', async () => {
    const { probe: app, bearer } = await probe()
    const mine = identity()
    const theirs = newOrganizationId()

    const response = await app.request(
      `/whoami?organizationId=${theirs}&organization_id=${theirs}`,
      {
        headers: {
          ...(await bearer(mine)),
          'x-organization-id': theirs,
          'x-forwarded-organization': theirs,
        },
      }
    )

    expect(await response.json()).toEqual(mine)
  })

  test('two Organizations calling the same route each see only their own identity', async () => {
    const { probe: app, bearer } = await probe()
    const first = identity()
    const second = identity()

    const one = await (await app.request('/whoami', { headers: await bearer(first) })).json()
    const two = await (await app.request('/whoami', { headers: await bearer(second) })).json()

    expect(one).toEqual(first)
    expect(two).toEqual(second)
    expect(one).not.toEqual(two)
  })
})

describe('no route is left outside the token check', () => {
  const OPEN = new Set(['/healthz', '/readyz', '/openapi.json'])
  /** The global middleware the app registers for every method: request id, guard, body limit, token check. */
  const MIDDLEWARE = new Set(['ALL /*', 'ALL /v1/*'])

  /** Every registered route that answers anything but 401 auth.unauthenticated to a request with no token. */
  async function unprotected(app: Awaited<ReturnType<typeof createTestApp>>['app']) {
    const walked: string[] = []
    const offenders: string[] = []
    for (const route of app.routes) {
      if (OPEN.has(route.path) || MIDDLEWARE.has(`${route.method} ${route.path}`)) {
        continue
      }
      // A route for every method is probed as a GET.
      const method = route.method === 'ALL' ? 'GET' : route.method
      const path = route.path
        .replace(/:[^/]+/g, 'x')
        .replace(/\{[^}]+\}/g, 'x')
        .replace(/\*/g, 'x')
      walked.push(`${route.method} ${route.path}`)
      const response = await app.request(path, { method })
      const body = (await response.json().catch(() => ({}))) as Body
      if (response.status !== 401 || body.error?.code !== 'auth.unauthenticated') {
        offenders.push(`${route.method} ${route.path}`)
      }
    }
    return { walked, offenders }
  }

  test('every route but health and the document answers 401 auth.unauthenticated without a token', async () => {
    const { app } = await createTestApp()

    expect((await unprotected(app)).offenders).toEqual([])
  })

  test('the walk sees the routes of the app, so an empty result means something', async () => {
    const { app } = await createTestApp()

    const paths = app.routes.map((route) => route.path)

    expect(paths).toContain('/healthz')
    expect(paths).toContain('/readyz')
    expect(paths).toContain('/openapi.json')
  })

  test('a throwaway route mounted outside the token check is caught', async () => {
    const { app } = await createTestApp()
    app.get('/leak/:id', (c) => c.json({ leaked: true }))
    app.post('/leak-too', (c) => c.json({ leaked: true }))
    app.all('/leak-all', (c) => c.json({ leaked: true }))

    const { offenders } = await unprotected(app)

    expect(offenders).toEqual(['GET /leak/:id', 'POST /leak-too', 'ALL /leak-all'])
  })
})
