import { describe, expect, test } from 'bun:test'
import { rightsStatusSchema } from 'tula-closeline-contract'
import { RIGHTS_CONFIRM } from 'tula-closeline-db'
import { postgresError } from '~/adapters/memory/playbook-database'
import { createDocumentHarness, errorCode, personIn } from '~/modules/document/test-support'
import { newOrganizationId, type TestIdentity } from '~/testing'

const RIGHTS = '/v1/playbook/rights-confirmation'

async function harness(version = '3') {
  const h = await createDocumentHarness({ env: { RIGHTS_WORDING_VERSION: version } })
  const send = async (
    method: string,
    options: { as?: TestIdentity | null; body?: unknown } = {}
  ) => {
    const auth = options.as === null ? {} : await h.bearer(options.as ?? h.people.owner)
    return h.app.request(RIGHTS, {
      method,
      headers: {
        ...auth,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }
  return { h, send }
}

describe('who may use the rights confirmation', () => {
  test.each([
    ['GET', undefined],
    ['PUT', { wordingVersion: 3 }],
  ])('%s needs a token and an Owner or Admin', async (method, body) => {
    const { h, send } = await harness()

    expect((await send(method, { as: null, body })).status).toBe(401)
    for (const role of ['manager', 'rep'] as const) {
      const denied = await send(method, { as: h.people[role], body })
      expect(denied.status).toBe(403)
      expect(await errorCode(denied)).toBe('auth.forbidden')
    }
    expect((await send(method, { as: h.people.admin, body })).status).toBe(200)
  })

  test('a second Organization sees no confirmation and its own confirmation stays apart', async () => {
    const { h, send } = await harness()
    await send('PUT', { body: { wordingVersion: 3 } })
    const stranger = personIn(newOrganizationId(), 'owner')

    const seen = rightsStatusSchema.parse(await (await send('GET', { as: stranger })).json())

    expect(seen).toEqual({ currentWordingVersion: 3, confirmation: null, confirmed: false })
    expect(h.deps.database.rights(h.organizationId)).toBeDefined()
  })
})

describe('reading and recording', () => {
  test('before anything is recorded: not confirmed, with the current wording version', async () => {
    const { send } = await harness()

    const body = rightsStatusSchema.parse(await (await send('GET')).json())

    expect(body).toEqual({ currentWordingVersion: 3, confirmation: null, confirmed: false })
  })

  test('confirming records who, when and the version, and a repeat keeps the first record', async () => {
    const { h, send } = await harness()

    const first = rightsStatusSchema.parse(
      await (await send('PUT', { body: { wordingVersion: 3 } })).json()
    )
    const again = rightsStatusSchema.parse(
      await (await send('PUT', { as: h.people.admin, body: { wordingVersion: 3 } })).json()
    )

    expect(first.confirmed).toBe(true)
    expect(first.confirmation).toMatchObject({
      wordingVersion: 3,
      confirmedByUserId: h.people.owner.userId,
    })
    expect(again).toEqual(first)
  })

  test('a stored older version is not confirmed once the wording moves on', async () => {
    const { h, send } = await harness('3')
    h.deps.database.seedRights({
      organization_id: h.organizationId,
      confirmed_by: h.people.owner.userId,
      confirmed_at: Date.now(),
      wording_version: 2,
    })

    const status = rightsStatusSchema.parse(await (await send('GET')).json())
    const confirmed = rightsStatusSchema.parse(
      await (await send('PUT', { body: { wordingVersion: 3 } })).json()
    )

    expect(status).toMatchObject({ currentWordingVersion: 3, confirmed: false })
    expect(status.confirmation?.wordingVersion).toBe(2)
    expect(confirmed).toMatchObject({ confirmed: true })
    expect(confirmed.confirmation?.wordingVersion).toBe(3)
  })
})

describe('failure paths', () => {
  test.each([
    ['an older wording version', { wordingVersion: 2 }],
    ['a newer wording version than the service knows', { wordingVersion: 4 }],
  ])('%s is rights.version_outdated and records nothing', async (_label, body) => {
    const { h, send } = await harness()

    const response = await send('PUT', { body })

    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('rights.version_outdated')
    expect(h.deps.database.rights(h.organizationId)).toBeUndefined()
  })

  test.each([
    ['no version', {}],
    ['a text version', { wordingVersion: 'three' }],
    ['a zero version', { wordingVersion: 0 }],
    [
      'an extra key (who is never taken from the body)',
      { wordingVersion: 3, confirmedByUserId: 'usr_x' },
    ],
  ])('%s is request.invalid', async (_label, body) => {
    const { send } = await harness()

    const response = await send('PUT', { body })

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('request.invalid')
  })

  test('a lock timeout is a retryable 503', async () => {
    const { h, send } = await harness()
    h.deps.database.failNext(RIGHTS_CONFIRM, postgresError('55P03'))

    const response = await send('PUT', { body: { wordingVersion: 3 } })

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
  })
})
