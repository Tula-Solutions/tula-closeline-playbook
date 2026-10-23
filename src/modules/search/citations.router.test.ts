import { describe, expect, test } from 'bun:test'
import {
  callSchema,
  documentSchema,
  MAX_CITATION_REFS,
  momentSnippet,
  type ResolveCitationsResponse,
  resolveCitationsResponseSchema,
} from 'tula-closeline-contract'
import { VECTOR_ERROR_CODES, VectorError } from 'tula-closeline-kit'
import { type CallHarness, createCallHarness } from '~/modules/call/test-support'
import { errorCode, personIn } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'

const RESOLVE = '/v1/playbook/citations/resolve'
const DOCUMENTS = '/v1/playbook/documents'
const PROSPECT_LINE = 'We are worried about the price of onboarding for the whole team'
const REP_ANSWER = 'We can cut onboarding in half with a guided plan'
const PRICING = 'Our onboarding price is 40 dollars per seat per month for teams of ten or more'

const conversation = (line = PROSPECT_LINE, answer = REP_ANSWER) =>
  `Alex: Thanks for joining today.\nSam: ${line}\nAlex: ${answer}\n`

const TWO_MOMENTS = `${conversation()}Sam: Does it integrate with our CRM\nAlex: Yes, it syncs every hour\n`

async function settle(h: CallHarness) {
  for (let pass = 0; pass < 50 && (await h.deps.workers.ingestion.runPass()) > 0; pass++) {}
}

/** A Call of a Deal, processed; `outcome` is set through the route when given. */
async function call(
  h: CallHarness,
  dealId: string,
  outcome: 'won' | 'lost' | null = 'won',
  as = h.people.owner,
  text = conversation(dealId === 'WON-1' ? PROSPECT_LINE : `${PROSPECT_LINE} (${dealId})`)
) {
  const response = await h.uploadCall(text, { dealId, as })
  expect(response.status).toBe(201)
  const created = callSchema.parse(await response.json())
  await settle(h)
  if (outcome !== null) {
    const set = await h.send('PUT', `/v1/playbook/deals/${created.dealRecordId}/outcome`, {
      body: { outcome },
      as,
    })
    expect(set.status).toBe(200)
    await settle(h)
  }
  return created
}

/** A document, processed or not (`process: false` leaves it uploaded). */
async function document(h: CallHarness, name: string, text: string, process = true, as?: never) {
  const response = await h.upload(name, new TextEncoder().encode(text), as ? { as } : {})
  expect(response.status).toBe(201)
  const created = documentSchema.parse(await response.json())
  if (process) {
    await settle(h)
  }
  return created
}

const resolve = (h: CallHarness, refs: unknown, options: Parameters<CallHarness['send']>[2] = {}) =>
  h.send('POST', RESOLVE, { body: { refs }, ...options })

const momentRef = (c: { id: string; dealRecordId: string }) => ({
  kind: 'moment' as const,
  callId: c.id,
  dealRecordId: c.dealRecordId,
})
const momentRefAt = (c: { id: string; dealRecordId: string }, momentIndex: number) => ({
  ...momentRef(c),
  momentIndex,
})
const documentRef = (id: string, page: number | null = null) => ({
  kind: 'document' as const,
  documentId: id,
  page,
})

/** The items of a 200 answer, and the raw text it came as. */
async function answer(response: Response) {
  expect(response.status).toBe(200)
  const text = await response.text()
  return { text, items: resolveCitationsResponseSchema.parse(JSON.parse(text)).items }
}

async function items(response: Response): Promise<ResolveCitationsResponse['items']> {
  return (await answer(response)).items
}

const pdfText = (...pages: string[]) => `%PDF-1.7\n${pages.join('\f')}\n%%EOF\n`

describe('who may resolve', () => {
  test('needs a token; all four roles are allowed', async () => {
    const h = await createCallHarness()
    const doc = await document(h, 'pricing.txt', PRICING)

    expect((await resolve(h, [documentRef(doc.id)], { as: null })).status).toBe(401)
    for (const role of ['owner', 'admin', 'manager', 'rep'] as const) {
      expect((await resolve(h, [documentRef(doc.id)], { as: h.people[role] })).status).toBe(200)
    }
  })
})

describe('what resolves', () => {
  test('a Moment of a won Deal: both snippets, the ids, nothing of the customer', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'WON-1')

    const [item] = await items(await resolve(h, [momentRef(c)]))

    expect(item).toEqual({
      state: 'available',
      kind: 'moment',
      callId: c.id,
      dealRecordId: c.dealRecordId,
      momentIndex: 0,
      prospect: momentSnippet(PROSPECT_LINE),
      repNext: momentSnippet(REP_ANSWER),
    })
    const wire = JSON.stringify(item)
    expect(wire).not.toContain('WON-1')
    expect(wire).not.toContain('dealId')
  })

  test('a Moment asked for by momentIndex resolves to exactly that Moment and echoes it', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'TWO-1', 'won', h.people.owner, TWO_MOMENTS)

    const [first, second] = await items(await resolve(h, [momentRefAt(c, 0), momentRefAt(c, 1)]))

    expect(first).toMatchObject({
      state: 'available',
      momentIndex: 0,
      prospect: momentSnippet(PROSPECT_LINE),
      repNext: momentSnippet(REP_ANSWER),
    })
    expect(second).toMatchObject({
      state: 'available',
      momentIndex: 1,
      prospect: momentSnippet('Does it integrate with our CRM'),
      repNext: momentSnippet('Yes, it syncs every hour'),
    })
  })

  test('a momentIndex the current build lacks is removed, with the index and no text', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'TWO-1', 'won', h.people.owner, TWO_MOMENTS)

    const { items: out, text } = await answer(await resolve(h, [momentRefAt(c, 2)]))

    expect(out[0]).toEqual({
      state: 'removed',
      kind: 'moment',
      callId: c.id,
      dealRecordId: c.dealRecordId,
      momentIndex: 2,
    })
    expect(text).not.toContain('CRM')
  })

  test('without momentIndex the lowest-numbered Moment resolves, and its index is echoed', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'TWO-1', 'won', h.people.owner, TWO_MOMENTS)

    const [item] = await items(await resolve(h, [momentRef(c)]))

    expect(item).toMatchObject({
      state: 'available',
      momentIndex: 0,
      prospect: momentSnippet(PROSPECT_LINE),
    })
  })

  test('a second Organization asking for a momentIndex gets removed', async () => {
    const h = await createCallHarness()
    const otherId = newOrganizationId()
    h.confirmRights(otherId)
    const stranger = personIn(otherId, 'owner')
    const mine = await call(h, 'TWO-1', 'won', h.people.owner, TWO_MOMENTS)

    const [item] = await items(await resolve(h, [momentRefAt(mine, 1)], { as: stranger }))

    expect(item).toEqual({
      state: 'removed',
      kind: 'moment',
      callId: mine.id,
      dealRecordId: mine.dealRecordId,
      momentIndex: 1,
    })
  })

  test('a document passage: file name and snippet, page null for a text file', async () => {
    const h = await createCallHarness()
    const doc = await document(h, 'pricing.txt', PRICING)

    const [item] = await items(await resolve(h, [documentRef(doc.id)]))

    expect(item).toEqual({
      state: 'available',
      kind: 'document',
      documentId: doc.id,
      page: null,
      fileName: 'pricing.txt',
      snippet: momentSnippet(PRICING),
    })
  })

  test('a PDF page resolves to that page; a page the file does not have is removed', async () => {
    const h = await createCallHarness()
    const long = (topic: string) => `${`Section about ${topic} and more. `.repeat(70)}ends here.`
    const doc = await document(h, 'handbook.pdf', pdfText(long('holidays'), long('pricing')))

    const [two, nine] = await items(
      await resolve(h, [documentRef(doc.id, 2), documentRef(doc.id, 9)])
    )

    expect(two).toMatchObject({ state: 'available', page: 2 })
    expect(JSON.stringify(two)).toContain('pricing')
    expect(nine).toEqual({ state: 'removed', kind: 'document', documentId: doc.id, page: 9 })
  })

  test('a snippet is at most the search limit, 512 characters', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'LONG', 'won', h.people.owner, conversation('word '.repeat(400)))

    const [item] = await items(await resolve(h, [momentRef(c)]))

    expect(item?.state).toBe('available')
    if (item?.state === 'available' && item.kind === 'moment') {
      expect(item.prospect.length).toBeLessThanOrEqual(512)
      expect(item.prospect.endsWith('…')).toBe(true)
    }
  })

  test('answers in request order, one item per reference, mixing kinds and states', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'WON-1')
    const doc = await document(h, 'pricing.txt', PRICING)
    const gone = { id: `call_${'0'.repeat(32)}`, dealRecordId: `deal_${'0'.repeat(32)}` }

    const out = await items(
      await resolve(h, [documentRef(doc.id), momentRef(gone), momentRef(c), documentRef(doc.id)])
    )

    expect(out.map((i) => `${i.kind}:${i.state}`)).toEqual([
      'document:available',
      'moment:removed',
      'moment:available',
      'document:available',
    ])
  })
})

describe('what is removed', () => {
  test('a deleted Document is removed with no text; restored, it resolves again', async () => {
    const h = await createCallHarness()
    const doc = await document(h, 'pricing.txt', PRICING)
    expect((await h.send('DELETE', `${DOCUMENTS}/${doc.id}`)).status).toBe(200)

    const response = await resolve(h, [documentRef(doc.id)])
    const { items: out, text } = await answer(response)

    expect(out[0]).toEqual({ state: 'removed', kind: 'document', documentId: doc.id, page: null })
    expect(text).not.toContain('onboarding')

    expect((await h.send('POST', `${DOCUMENTS}/${doc.id}/restore`)).status).toBe(200)
    await settle(h)
    expect((await items(await resolve(h, [documentRef(doc.id)])))[0]?.state).toBe('available')
  })

  test('a Document not searchable yet is removed', async () => {
    const h = await createCallHarness()
    const doc = await document(h, 'pricing.txt', PRICING, false)

    expect((await items(await resolve(h, [documentRef(doc.id)])))[0]?.state).toBe('removed')
  })

  test('a Moment of a Deal that is not won, or of a deleted Call, is removed', async () => {
    const h = await createCallHarness()
    const lost = await call(h, 'LOST-1', 'lost')
    const open = await call(h, 'OPEN-1', null)
    const deleted = await call(h, 'WON-2')
    expect((await h.send('DELETE', `/v1/playbook/calls/${deleted.id}`)).status).toBe(200)

    const out = await items(
      await resolve(h, [momentRef(lost), momentRef(open), momentRef(deleted)])
    )

    expect(out.map((i) => i.state)).toEqual(['removed', 'removed', 'removed'])
    expect(JSON.stringify(out)).not.toContain('onboarding')
  })

  test('a Moment whose Deal id is not the Call’s Deal is removed', async () => {
    const h = await createCallHarness()
    const a = await call(h, 'WON-A')
    const b = await call(h, 'WON-B')

    const [item] = await items(
      await resolve(h, [{ kind: 'moment', callId: a.id, dealRecordId: b.dealRecordId }])
    )

    expect(item?.state).toBe('removed')
  })

  test('a reference from a second Organization is removed, and the answer is the same as for nothing', async () => {
    const h = await createCallHarness()
    const otherId = newOrganizationId()
    h.confirmRights(otherId)
    const stranger = personIn(otherId, 'owner')
    const theirCall = await call(h, 'THEIRS', 'won', stranger)
    const theirDoc = await document(h, 'theirs.txt', PRICING, true, stranger as never)
    const unknown = { id: `call_${'1'.repeat(32)}`, dealRecordId: `deal_${'1'.repeat(32)}` }

    const response = await resolve(h, [
      momentRef(theirCall),
      documentRef(theirDoc.id),
      momentRef(unknown),
    ])
    const { items: out, text } = await answer(response)

    expect(out.map((i) => i.state)).toEqual(['removed', 'removed', 'removed'])
    expect(text).not.toContain('onboarding')
    expect(text).not.toContain('THEIRS')
    // They resolve their own.
    expect(
      (await items(await resolve(h, [momentRef(theirCall)], { as: stranger })))[0]?.state
    ).toBe('available')
  })

  test('the vector store is only searched in the caller’s Organization', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'WON-1')
    const namespaces: string[] = []
    const base = h.deps.vectors.search.bind(h.deps.vectors)
    h.deps.vectors.search = async (organizationId, query) => {
      namespaces.push(organizationId)
      return base(organizationId, query)
    }

    await resolve(h, [momentRef(c)])

    expect(namespaces).toEqual([h.organizationId])
  })
})

describe('bounds', () => {
  test(`${MAX_CITATION_REFS} references are accepted, ${MAX_CITATION_REFS + 1} are request.invalid`, async () => {
    const h = await createCallHarness()
    const doc = await document(h, 'pricing.txt', PRICING)

    const ok = await resolve(
      h,
      Array.from({ length: MAX_CITATION_REFS }, () => documentRef(doc.id))
    )
    expect((await items(ok)).length).toBe(MAX_CITATION_REFS)

    const tooMany = await resolve(
      h,
      Array.from({ length: MAX_CITATION_REFS + 1 }, () => documentRef(doc.id))
    )
    expect(tooMany.status).toBe(400)
    expect(await errorCode(tooMany)).toBe('request.invalid')
  })

  test('an empty list and an unknown field are request.invalid', async () => {
    const h = await createCallHarness()
    expect(await errorCode(await resolve(h, []))).toBe('request.invalid')
    expect(
      await errorCode(
        await resolve(h, [{ kind: 'document', documentId: 'doc_x', page: null, extra: 1 }])
      )
    ).toBe('request.invalid')
  })

  test('reads Postgres once for each kind, however many references', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'WON-1')
    const doc = await document(h, 'pricing.txt', PRICING)
    h.deps.database.statements.length = 0

    await resolve(h, [
      ...Array.from({ length: 10 }, () => momentRef(c)),
      ...Array.from({ length: 10 }, () => documentRef(doc.id)),
    ])

    const reads = h.deps.database.statements.filter((sql) => /^\s*select/i.test(sql))
    expect(reads).toHaveLength(2)
  })
})

describe('what is never logged', () => {
  test('no snippet, file name or ref text reaches the logs, on success or on a refusal', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'WON-1')
    const doc = await document(h, 'pricing-secret-name.txt', PRICING)
    h.deps.logLines.length = 0

    await resolve(h, [momentRef(c), documentRef(doc.id)])
    await resolve(
      h,
      Array.from({ length: 21 }, () => documentRef(doc.id))
    )
    h.deps.random = () => 0
    h.deps.vectors.search = async () => {
      throw new VectorError(VECTOR_ERROR_CODES.unavailable, 'down')
    }
    await resolve(h, [momentRef(c)])

    const logs = h.deps.logLines.join('\n')
    for (const secret of [
      PROSPECT_LINE,
      REP_ANSWER,
      'onboarding',
      'pricing-secret-name',
      'WON-1',
    ]) {
      expect(logs).not.toContain(secret)
    }
  })
})

describe('failures', () => {
  test('a vector store that is down is 503 with Retry-After, not a removed item', async () => {
    const h = await createCallHarness()
    const c = await call(h, 'WON-1')
    h.deps.random = () => 0
    h.deps.vectors.search = async () => {
      throw new VectorError(VECTOR_ERROR_CODES.unavailable, 'down')
    }

    const response = await resolve(h, [momentRef(c)])

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await errorCode(response)).toBe('server.unavailable')
  })
})
