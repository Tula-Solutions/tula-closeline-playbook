import { describe, expect, test } from 'bun:test'
import { callSchema, searchMomentsResponseSchema } from 'tula-closeline-contract'
import { createCallHarness } from '~/modules/call/test-support'
import { errorCode, INTERNAL_SECRET, personIn } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'

const PATH = '/internal/v1/playbook/search/moments'
const LINE = 'We are worried about the price of onboarding for the whole team'

type Harness = Awaited<ReturnType<typeof createCallHarness>>

const call = (
  h: Harness,
  options: { secret?: string | null; organizationId?: string | null } = {}
) =>
  h.app.request(PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.secret === null
        ? {}
        : { authorization: `Bearer ${options.secret ?? INTERNAL_SECRET}` }),
      ...(options.organizationId === null
        ? {}
        : { 'x-organization-id': options.organizationId ?? h.people.owner.organizationId }),
    },
    body: JSON.stringify({ turns: [{ role: 'prospect', text: 'worried about the price' }] }),
  })

/** Uploads a Transcript for a Deal as `as`, marks the Deal won and processes every job. */
async function wonCall(h: Harness, dealId: string, as = h.people.owner) {
  const up = await h.uploadCall(`Alex: Hi.\nSam: ${LINE}\nAlex: We can cut it in half\n`, {
    dealId,
    as,
  })
  expect(up.status).toBe(201)
  const made = callSchema.parse(await up.json())
  const settle = async () => {
    for (let pass = 0; pass < 50 && (await h.deps.workers.ingestion.runPass()) > 0; pass++) {}
  }
  await settle()
  const won = await h.send('PUT', `/v1/playbook/deals/${made.dealRecordId}/outcome`, {
    body: { outcome: 'won' },
    as,
  })
  expect(won.status).toBe(200)
  await settle()
  return made
}

describe('internal Moment search', () => {
  test('returns the named Organization Moments and never another Organizations', async () => {
    const h = await createCallHarness()
    const mine = await wonCall(h, 'WON-1')
    const otherPerson = personIn(newOrganizationId(), 'owner')
    h.confirmRights(otherPerson.organizationId)
    const theirs = await wonCall(h, 'WON-2', otherPerson)
    const ids = async (organizationId: string) => {
      const response = await call(h, { organizationId })
      expect(response.status).toBe(200)
      return searchMomentsResponseSchema.parse(await response.json()).items.map((i) => i.callId)
    }
    expect(await ids(h.people.owner.organizationId)).toEqual([mine.id])
    expect(await ids(otherPerson.organizationId)).toEqual([theirs.id])
    expect(await ids(newOrganizationId())).toEqual([])
  })

  test('is refused without the shared secret, with a wrong one or with a user token', async () => {
    const h = await createCallHarness()
    for (const secret of [null, 'wrong-secret-wrong-secret-wrong-secret-0']) {
      const response = await call(h, { secret })
      expect(response.status).toBe(401)
      expect(await errorCode(response)).toBe('auth.unauthenticated')
    }
    const user = await h.bearer(h.people.owner)
    const asUser = await h.app.request(PATH, {
      method: 'POST',
      headers: {
        ...user,
        'content-type': 'application/json',
        'x-organization-id': h.people.owner.organizationId,
      },
      body: JSON.stringify({ turns: [{ role: 'prospect', text: 'price' }] }),
    })
    expect(asUser.status).toBe(401)
    expect((await call(h, { organizationId: null })).status).toBe(400)
  })
})
