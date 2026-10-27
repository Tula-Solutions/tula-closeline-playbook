import { describe, expect, test } from 'bun:test'
import { documentSchema, searchDocumentsResponseSchema } from 'tula-closeline-contract'
import {
  createDocumentHarness,
  errorCode,
  INTERNAL_SECRET,
  personIn,
} from '~/modules/document/test-support'
import { newOrganizationId, type TestIdentity } from '~/testing'

const PATH = '/internal/v1/playbook/search/documents'
const PRICING = 'Our onboarding price is 40 dollars per seat per month for teams of ten or more'

type Harness = Awaited<ReturnType<typeof createDocumentHarness>>

/** Uploads a text file as the Owner, processes it, and returns the document. */
async function ready(h: Harness, name: string, text: string, as?: TestIdentity) {
  const response = await h.upload(name, new TextEncoder().encode(text), as ? { as } : {})
  expect(response.status).toBe(201)
  const document = documentSchema.parse(await response.json())
  for (let pass = 0; pass < 50 && (await h.deps.workers.ingestion.runPass()) > 0; pass++) {}
  return document
}

const call = (
  h: Harness,
  options: { secret?: string | null; organizationId?: string | null; body?: unknown } = {}
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
    body: JSON.stringify(
      options.body ?? { turns: [{ role: 'prospect', text: 'what does onboarding cost per seat' }] }
    ),
  })

describe('internal document search for the Inbound Agent', () => {
  test('returns the passages of the named Organization with score and citation', async () => {
    const h = await createDocumentHarness()
    const document = await ready(h, 'pricing.txt', PRICING)

    const response = await call(h)

    expect(response.status).toBe(200)
    const body = searchDocumentsResponseSchema.parse(await response.json())
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      documentId: document.id,
      fileName: 'pricing.txt',
      page: null,
    })
    expect(typeof body.items[0]?.score).toBe('number')
  })

  test('another Organization gets none of the first one passages', async () => {
    const h = await createDocumentHarness()
    await ready(h, 'pricing.txt', PRICING)

    const response = await call(h, { organizationId: newOrganizationId() })

    expect(response.status).toBe(200)
    expect(searchDocumentsResponseSchema.parse(await response.json()).items).toEqual([])
  })

  test('a limit above the maximum is refused', async () => {
    const h = await createDocumentHarness()
    const response = await call(h, {
      body: { turns: [{ role: 'prospect', text: 'price' }], limit: 21 },
    })
    expect(response.status).toBe(400)
  })

  test('a missing, wrong or user-token credential is refused, and so is a bad Organization header', async () => {
    const h = await createDocumentHarness()
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
    expect((await call(h, { organizationId: 'not-an-org' })).status).toBe(400)
  })

  test('each Organization gets only its own passages', async () => {
    const h = await createDocumentHarness()
    const mine = await ready(h, 'pricing.txt', PRICING)
    const otherPerson = personIn(newOrganizationId(), 'owner')
    const theirs = await ready(h, 'theirs.txt', PRICING, otherPerson)
    const ids = async (organizationId: string) =>
      searchDocumentsResponseSchema
        .parse(await (await call(h, { organizationId })).json())
        .items.map((item) => item.documentId)
    expect(await ids(h.people.owner.organizationId)).toContain(mine.id)
    expect(await ids(h.people.owner.organizationId)).not.toContain(theirs.id)
    expect(await ids(otherPerson.organizationId)).toEqual([theirs.id])
  })

  test('the OpenAPI document promises no 403 for it', async () => {
    const h = await createDocumentHarness()
    const doc = (await (await h.app.request('/openapi.json')).json()) as {
      paths: Record<string, { post: { responses: Record<string, unknown> } }>
    }
    const responses = Object.keys(doc.paths[PATH]?.post.responses ?? {})
    expect(responses).toContain('401')
    expect(responses).not.toContain('403')
  })
})
