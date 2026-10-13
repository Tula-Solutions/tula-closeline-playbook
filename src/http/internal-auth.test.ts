import { describe, expect, test } from 'bun:test'
import { ERRORS } from 'tula-closeline-contract'
import { createBaseApp } from '~/http/base'
import { createTestDeps } from '~/testing'
import { internalAuth, matchesAny } from './internal-auth'

const CURRENT = 'current-secret-0123456789abcdef-xyz'
const NEXT = 'next-secret-0123456789abcdef-uvwxyz'

function build(secrets: readonly string[]) {
  const app = createBaseApp(createTestDeps())
  app.use('*', internalAuth(secrets))
  app.get('/ping', (c) => c.json({ ok: true }))
  return app
}

async function call(secrets: readonly string[], authorization?: string) {
  const response = await build(secrets).request(
    '/ping',
    authorization === undefined ? undefined : { headers: { authorization } }
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('internalAuth', () => {
  test('the configured secret is let in', async () => {
    expect(await call([CURRENT], `Bearer ${CURRENT}`)).toEqual({ status: 200, body: { ok: true } })
  })

  test('during a rotation either of the two secrets is let in', async () => {
    expect((await call([CURRENT, NEXT], `Bearer ${NEXT}`)).status).toBe(200)
    expect((await call([CURRENT, NEXT], `Bearer ${CURRENT}`)).status).toBe(200)
  })

  test.each([
    ['no header', undefined],
    ['a wrong secret', 'Bearer not-the-secret-0123456789abcdef-xyz!'],
    ['a secret one character short', `Bearer ${CURRENT.slice(0, -1)}`],
    ['a secret one character long', `Bearer ${CURRENT}x`],
    ['a secret that differs in its last character', `Bearer ${CURRENT.slice(0, -1)}!`],
    ['the secret without the scheme', CURRENT],
    ['a different scheme', `Basic ${CURRENT}`],
    ['two tokens', `Bearer ${CURRENT} ${CURRENT}`],
    ['an empty token', 'Bearer '],
  ])('%s is refused as unauthenticated', async (_name, authorization) => {
    const { status, body } = await call([CURRENT], authorization)

    expect(status).toBe(401)
    expect(body).toEqual({
      error: {
        code: ERRORS['auth.unauthenticated'].code,
        message: ERRORS['auth.unauthenticated'].message,
      },
    })
  })

  test('with no secret configured nothing is let in, not even an empty one', async () => {
    expect((await call([], `Bearer ${CURRENT}`)).status).toBe(401)
    expect((await call([], 'Bearer x')).status).toBe(401)
  })

  test('the scheme is case-insensitive, as HTTP says', async () => {
    expect((await call([CURRENT], `bearer ${CURRENT}`)).status).toBe(200)
  })

  test('a refusal says nothing of the secret it wanted or the one it got', async () => {
    const deps = createTestDeps()
    const guarded = createBaseApp(deps)
    guarded.use('*', internalAuth([CURRENT]))
    guarded.get('/ping', (c) => c.json({ ok: true }))

    const response = await guarded.request('/ping', {
      headers: { authorization: 'Bearer wrong-secret-value' },
    })
    const text = await response.text()

    expect(text).not.toContain(CURRENT)
    expect(text).not.toContain('wrong-secret-value')
    expect(deps.logLines.join('\n')).not.toContain('wrong-secret-value')
    expect(deps.logLines.join('\n')).not.toContain(CURRENT)
  })
})

describe('matchesAny', () => {
  test('compares against every secret and answers only whether one matched', () => {
    expect(matchesAny(NEXT, [CURRENT, NEXT])).toBe(true)
    expect(matchesAny(CURRENT, [CURRENT, NEXT])).toBe(true)
    expect(matchesAny('other', [CURRENT, NEXT])).toBe(false)
    expect(matchesAny(CURRENT, [])).toBe(false)
  })
})
