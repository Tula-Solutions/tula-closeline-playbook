import { describe, expect, test } from 'bun:test'
import {
  CURRENT_RIGHTS_WORDING_VERSION,
  RIGHTS_WORDINGS,
  rightsStatusSchema,
  rightsWordingFor,
} from 'tula-closeline-contract'
import { RIGHTS_CONFIRM } from 'tula-closeline-db'
import { postgresError } from '~/adapters/memory/playbook-database'
import { createDocumentHarness, errorCode, personIn } from '~/modules/document/test-support'
import { newOrganizationId, type TestIdentity } from '~/testing'

const RIGHTS = '/v1/playbook/rights-confirmation'

const CURRENT = CURRENT_RIGHTS_WORDING_VERSION
const WORDING = rightsWordingFor(CURRENT)

async function harness() {
  const h = await createDocumentHarness()
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
    ['PUT', { wordingVersion: CURRENT }],
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
    await send('PUT', { body: { wordingVersion: CURRENT } })
    const stranger = personIn(newOrganizationId(), 'owner')

    const seen = rightsStatusSchema.parse(await (await send('GET', { as: stranger })).json())

    expect(seen).toEqual({
      currentWordingVersion: CURRENT,
      currentWording: WORDING,
      confirmation: null,
      confirmed: false,
    })
    expect(h.deps.database.rights(h.organizationId)).toBeDefined()
  })
})

describe('reading and recording', () => {
  test('before anything is recorded: not confirmed, with the current wording version', async () => {
    const { send } = await harness()

    const body = rightsStatusSchema.parse(await (await send('GET')).json())

    expect(body).toEqual({
      currentWordingVersion: CURRENT,
      currentWording: WORDING,
      confirmation: null,
      confirmed: false,
    })
  })

  test('confirming records who, when and the version, and a repeat keeps the first record', async () => {
    const { h, send } = await harness()

    const first = rightsStatusSchema.parse(
      await (await send('PUT', { body: { wordingVersion: CURRENT } })).json()
    )
    const again = rightsStatusSchema.parse(
      await (await send('PUT', { as: h.people.admin, body: { wordingVersion: CURRENT } })).json()
    )

    expect(first.confirmed).toBe(true)
    expect(first.confirmation).toMatchObject({
      wordingVersion: CURRENT,
      confirmedByUserId: h.people.owner.userId,
    })
    expect(again).toEqual(first)
  })

  test('a stored version other than the current one is not confirmed', async () => {
    const { h, send } = await harness()
    h.deps.database.seedRights({
      organization_id: h.organizationId,
      confirmed_by: h.people.owner.userId,
      confirmed_at: Date.now(),
      wording_version: CURRENT + 1,
    })

    const status = rightsStatusSchema.parse(await (await send('GET')).json())

    expect(status).toMatchObject({ currentWordingVersion: CURRENT, confirmed: false })
    expect(status.confirmation?.wordingVersion).toBe(CURRENT + 1)
  })
})

describe('the wording text comes from the contract', () => {
  test('every version the service can ask for has text in the contract', () => {
    expect(rightsWordingFor(CURRENT)).toBeDefined()
    expect(Object.keys(RIGHTS_WORDINGS).map(Number)).toContain(CURRENT)
  })

  test('the read route returns exactly the text of the version it reports', async () => {
    const { send } = await harness()

    const status = rightsStatusSchema.parse(await (await send('GET')).json())

    expect(status.currentWordingVersion).toBe(CURRENT)
    expect(status.currentWording).toEqual(rightsWordingFor(status.currentWordingVersion))
  })

  test('confirming answers with the same text', async () => {
    const { send } = await harness()

    const status = rightsStatusSchema.parse(
      await (await send('PUT', { body: { wordingVersion: CURRENT } })).json()
    )

    expect(status.currentWording).toEqual(WORDING)
  })
})

describe('failure paths', () => {
  test.each([
    ['a version far above the current one', { wordingVersion: CURRENT + 100 }],
    ['a newer wording version than the contract has text for', { wordingVersion: CURRENT + 1 }],
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
      { wordingVersion: CURRENT, confirmedByUserId: 'usr_x' },
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

    const response = await send('PUT', { body: { wordingVersion: CURRENT } })

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
  })
})
