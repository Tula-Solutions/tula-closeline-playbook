import { describe, expect, test } from 'bun:test'
import {
  documentSchema,
  momentSnippet,
  searchDocumentsResponseSchema,
} from 'tula-closeline-contract'
import { VECTOR_ERROR_CODES, VectorError } from 'tula-closeline-kit'
import { createDocumentHarness, errorCode, personIn } from '~/modules/document/test-support'
import { newOrganizationId, type TestIdentity } from '~/testing'

const SEARCH = '/v1/playbook/search/documents'
const DOCUMENTS = '/v1/playbook/documents'
const PRICING = 'Our onboarding price is 40 dollars per seat per month for teams of ten or more'

type Harness = Awaited<ReturnType<typeof createDocumentHarness>>

/** A request as `as` (an Owner by default; `null` for none) with an optional JSON body. */
async function send(
  h: Harness,
  method: string,
  path: string,
  options: { body?: unknown; as?: TestIdentity | null } = {}
) {
  const auth = options.as === null ? {} : await h.bearer(options.as ?? h.people.owner)
  return h.app.request(path, {
    method,
    headers: {
      ...auth,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

const search = (h: Harness, body: unknown, options: { as?: TestIdentity | null } = {}) =>
  send(h, 'POST', SEARCH, { body, ...options })

const ask = (text: string, limit?: number) => ({
  turns: [{ role: 'prospect', text }],
  ...(limit === undefined ? {} : { limit }),
})

/** Runs the ingestion worker until nothing is left to do. */
async function settle(h: Harness) {
  for (let pass = 0; pass < 50 && (await h.deps.workers.ingestion.runPass()) > 0; pass++) {}
}

/** Uploads a file as `as`, processes it, and returns the document. */
async function ready(h: Harness, name: string, text: string, as?: TestIdentity) {
  const response = await h.upload(name, new TextEncoder().encode(text), as ? { as } : {})
  expect(response.status).toBe(201)
  const document = documentSchema.parse(await response.json())
  await settle(h)
  return document
}

const pdfText = (...pages: string[]) => `%PDF-1.7\n${pages.join('\f')}\n%%EOF\n`

describe('who may search documents', () => {
  test('needs a token; all four roles are allowed', async () => {
    const h = await createDocumentHarness()

    expect((await search(h, ask('price'), { as: null })).status).toBe(401)
    for (const role of ['owner', 'admin', 'manager', 'rep'] as const) {
      expect((await search(h, ask('price'), { as: h.people[role] })).status).toBe(200)
    }
  })
})

describe('what a document search returns', () => {
  test('a chunk of a ready document with its file name, snippet and evidence', async () => {
    const h = await createDocumentHarness()
    const document = await ready(h, 'pricing.txt', PRICING)

    const response = await search(h, ask('what does onboarding cost per seat'), {
      as: h.people.rep,
    })

    expect(response.status).toBe(200)
    const body = searchDocumentsResponseSchema.parse(await response.json())
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      documentId: document.id,
      fileName: 'pricing.txt',
      page: null,
      snippet: momentSnippet(PRICING),
    })
    expect(body.evidence).toEqual({ chunks: 1, documents: 1 })
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      ['documentId', 'fileName', 'page', 'score', 'snippet'].sort()
    )
  })

  test('a PDF hit has its 1-based page, a text file has null', async () => {
    const h = await createDocumentHarness()
    const longPage = (topic: string) =>
      `${`Section about ${topic} and more. `.repeat(70)}ends here.`
    await ready(h, 'handbook.pdf', pdfText(longPage('holidays'), longPage('pricing')))
    await ready(h, 'notes.txt', 'Notes about the quarterly offsite and travel')

    const body = searchDocumentsResponseSchema.parse(
      await (await search(h, ask('onboarding price per seat', 20))).json()
    )

    const pdfPages = body.items
      .filter((item) => item.fileName === 'handbook.pdf')
      .map((item) => item.page)
    const text = body.items.find((item) => item.fileName === 'notes.txt')
    expect([...new Set(pdfPages)].sort()).toEqual([1, 2])
    expect(text?.page).toBeNull()
  })

  test('embeds the query once, as a query, with the plain document text (no role labels)', async () => {
    const h = await createDocumentHarness()
    await ready(h, 'pricing.txt', PRICING)
    h.deps.embedder.calls.length = 0

    await search(h, {
      turns: [
        { role: 'rep', text: '  Hello again  ' },
        { role: 'prospect', text: ' the price worries me ' },
      ],
    })

    expect(h.deps.embedder.calls).toEqual([
      { texts: ['Hello again\nthe price worries me'], purpose: 'query' },
    ])
  })

  test('the vector store is asked for min(100, limit x 5) chunks of kind document, layout 2', async () => {
    const h = await createDocumentHarness()
    const seen: unknown[] = []
    const base = h.deps.vectors.search.bind(h.deps.vectors)
    h.deps.vectors.search = async (organizationId, query) => {
      seen.push({ topK: query.topK, filter: query.filter })
      return base(organizationId, query)
    }

    await search(h, ask('price', 3))
    await search(h, ask('price', 20))

    expect(seen).toEqual([
      { topK: 15, filter: { kind: 'document', v: 2 } },
      { topK: 100, filter: { kind: 'document', v: 2 } },
    ])
  })

  test('Moments are never returned, nor are chunks written before the snippets existed', async () => {
    const h = await createDocumentHarness()
    const document = await ready(h, 'pricing.txt', PRICING)
    const hits = await h.deps.vectors.search(h.organizationId, {
      vector: new Array<number>(h.deps.embedder.dimensions).fill(0.1),
      topK: 100,
      filter: { document_id: document.id },
    })
    for (const hit of hits) {
      const { v: _v, ...rest } = hit.attributes
      await h.deps.vectors.upsert(h.organizationId, [
        {
          id: hit.id,
          vector: new Array<number>(h.deps.embedder.dimensions).fill(0.1),
          attributes: rest,
        },
      ])
    }

    const body = searchDocumentsResponseSchema.parse(
      await (await search(h, ask('onboarding price'))).json()
    )

    expect(body.items).toEqual([])
  })

  test('a chunk vector carries the snippet, kind and layout version', async () => {
    const h = await createDocumentHarness()
    const document = await ready(h, 'pricing.txt', PRICING)

    const [hit] = await h.deps.vectors.search(h.organizationId, {
      vector: new Array<number>(h.deps.embedder.dimensions).fill(0.1),
      topK: 1,
      filter: { document_id: document.id },
    })

    expect(hit?.attributes).toMatchObject({
      snippet: momentSnippet(PRICING),
      kind: 'document',
      v: 2,
    })
  })

  test('600 emoji in a chunk reach ready, fit the store and are found', async () => {
    const h = await createDocumentHarness()
    const document = await ready(h, 'emoji.txt', `${'😀'.repeat(600)}`)

    expect(
      h.deps.database.documents(h.organizationId).find((d) => d.id === document.id)?.state
    ).toBe('ready')
    const body = searchDocumentsResponseSchema.parse(await (await search(h, ask('emoji'))).json())
    expect(body.items.map((item) => item.documentId)).toEqual([document.id])
    expect(body.items[0]?.snippet.length).toBeLessThanOrEqual(512)
  })

  test('limit cuts the items; evidence still counts the whole window', async () => {
    const h = await createDocumentHarness()
    for (let i = 0; i < 4; i++) {
      await ready(h, `doc-${i}.txt`, `${PRICING} variant ${i}`)
    }

    const body = searchDocumentsResponseSchema.parse(
      await (await search(h, ask('onboarding price', 2))).json()
    )

    expect(body.items).toHaveLength(2)
    expect(body.evidence).toEqual({ chunks: 4, documents: 4 })
  })
})

describe('request.invalid', () => {
  test.each([
    ['no turns', { turns: [] }],
    ['seven turns', { turns: Array.from({ length: 7 }, () => ({ role: 'rep', text: 'x' })) }],
    ['limit 0', ask('x', 0)],
    ['limit 21', ask('x', 21)],
    ['more than 2000 characters', ask('x'.repeat(2001))],
    ['a whitespace-only turn', ask('   ')],
    ['an unknown role', { turns: [{ role: 'boss', text: 'x' }] }],
    ['an unknown key', { ...ask('x'), extra: 1 }],
  ])('%s is 400', async (_label, body) => {
    const h = await createDocumentHarness()

    const response = await search(h, body)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('request.invalid')
  })
})

describe('what is never returned', () => {
  test('a deleted document disappears at once; restored, it is found again', async () => {
    const h = await createDocumentHarness()
    const document = await ready(h, 'pricing.txt', PRICING)
    const found = async () =>
      searchDocumentsResponseSchema
        .parse(await (await search(h, ask('onboarding price'))).json())
        .items.map((item) => item.documentId)
    expect(await found()).toEqual([document.id])

    expect((await send(h, 'DELETE', `${DOCUMENTS}/${document.id}`)).status).toBe(200)
    // The cleanup job has not run: the vectors are still there, Postgres knows.
    expect(await found()).toEqual([])

    expect((await send(h, 'POST', `${DOCUMENTS}/${document.id}/restore`)).status).toBe(200)
    await settle(h)
    expect(await found()).toEqual([document.id])
  })

  test('a vector of an older epoch of the document is dropped', async () => {
    const h = await createDocumentHarness()
    const document = await ready(h, 'pricing.txt', PRICING)
    const [current] = await h.deps.vectors.search(h.organizationId, {
      vector: new Array<number>(h.deps.embedder.dimensions).fill(0.1),
      topK: 1,
      filter: { document_id: document.id },
    })
    expect(current).toBeDefined()
    await h.deps.vectors.upsert(h.organizationId, [
      {
        id: 'older:epoch',
        vector: new Array<number>(h.deps.embedder.dimensions).fill(0.1),
        attributes: { ...current?.attributes, epoch: 99, snippet: 'STALE-EPOCH-TEXT' },
      },
    ])

    const text = await (await search(h, ask('onboarding price'))).text()

    expect(text).not.toContain('STALE-EPOCH-TEXT')
  })

  test('a document that is not ready (uploaded, not yet processed) is not returned', async () => {
    const h = await createDocumentHarness()
    const response = await h.upload('pricing.txt', new TextEncoder().encode(PRICING))
    expect(response.status).toBe(201)

    const body = searchDocumentsResponseSchema.parse(
      await (await search(h, ask('onboarding price'))).json()
    )

    expect(body.items).toEqual([])
  })
})

describe('when the model or the store cannot answer', () => {
  test('an embedder that fails is 503 with Retry-After and no text is logged', async () => {
    const h = await createDocumentHarness()
    h.deps.embedder.embed = async () => {
      throw new Error('down: SECRET-QUERY-TEXT')
    }

    const response = await search(h, ask('SECRET-QUERY-TEXT'))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).not.toBeNull()
    expect(h.deps.logLines.join('\n')).not.toContain('SECRET-QUERY-TEXT')
  })

  test('a vector store unavailable once is retried; a hang is 504', async () => {
    const h = await createDocumentHarness()
    await ready(h, 'pricing.txt', PRICING)
    h.deps.random = () => 0
    const base = h.deps.vectors.search.bind(h.deps.vectors)
    let attempts = 0
    h.deps.vectors.search = async (organizationId, query) => {
      attempts++
      if (attempts === 1) {
        throw new VectorError(VECTOR_ERROR_CODES.unavailable, 'down')
      }
      return base(organizationId, query)
    }
    expect((await search(h, ask('onboarding price'))).status).toBe(200)
    expect(attempts).toBe(2)

    h.deps.vectors.search = () => new Promise(() => undefined)
    const pending = search(h, ask('onboarding price'))
    for (let tick = 0; tick < 20; tick++) {
      await Bun.sleep(0)
      await h.deps.time.advance(h.deps.env.SEARCH_STEP_TIMEOUT_MS + 1)
    }
    const response = await pending
    expect(response.status).toBe(504)
    expect(await errorCode(response)).toBe('server.timeout')
  })

  test('a database read that never answers is 504; a lost connection is 503', async () => {
    const h = await createDocumentHarness()
    await ready(h, 'pricing.txt', PRICING)
    const scope = h.deps.scope
    h.deps.scope = (organizationId, fn) => {
      void organizationId
      void fn
      return new Promise(() => undefined)
    }
    const pending = search(h, ask('onboarding price'))
    for (let tick = 0; tick < 20; tick++) {
      await Bun.sleep(0)
      await h.deps.time.advance(h.deps.env.SEARCH_STEP_TIMEOUT_MS + 1)
    }
    expect((await pending).status).toBe(504)

    h.deps.scope = async () => {
      throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' })
    }
    const lost = await search(h, ask('onboarding price'))
    expect(lost.status).toBe(503)
    expect(lost.headers.get('retry-after')).not.toBeNull()
    h.deps.scope = scope
  })

  test('the read sets a statement timeout first', async () => {
    const h = await createDocumentHarness()
    await ready(h, 'pricing.txt', PRICING)
    const before = h.deps.database.transactionStatements.length

    await search(h, ask('onboarding price'))

    const [statements] = h.deps.database.transactionStatements.slice(before)
    expect(statements?.[0]).toBe(
      `set local statement_timeout = '${h.deps.env.SEARCH_STEP_TIMEOUT_MS}ms'`
    )
  })
})

describe('a second Organization', () => {
  const otherIn = () => personIn(newOrganizationId(), 'owner')
  personIn(newOrganizationId(), 'owner') as TestIdentity & { h?: Harness }

  test('gets only its own documents, and the first only its own', async () => {
    const h = await createDocumentHarness()
    const stranger = otherIn()
    const mine = await ready(h, 'mine.txt', PRICING)
    const theirs = await ready(h, 'theirs.txt', PRICING, stranger)

    const first = searchDocumentsResponseSchema.parse(
      await (await search(h, ask('onboarding price'))).json()
    )
    const second = searchDocumentsResponseSchema.parse(
      await (await search(h, ask('onboarding price'), { as: stranger })).json()
    )

    expect(first.items.map((item) => item.documentId)).toEqual([mine.id])
    expect(second.items.map((item) => item.documentId)).toEqual([theirs.id])
  })

  test("the vector store is only ever searched in the caller's Organization", async () => {
    const h = await createDocumentHarness()
    const stranger = otherIn()
    const namespaces: string[] = []
    const base = h.deps.vectors.search.bind(h.deps.vectors)
    h.deps.vectors.search = async (organizationId, query) => {
      namespaces.push(organizationId)
      return base(organizationId, query)
    }

    await search(h, ask('price'))
    await search(h, ask('price'), { as: stranger })

    expect(namespaces).toEqual([h.organizationId, stranger.organizationId])
  })

  test("a foreign document id planted in the caller's namespace is dropped, its text never returned", async () => {
    const h = await createDocumentHarness()
    const stranger = otherIn()
    const theirs = await ready(h, 'theirs.txt', PRICING, stranger)
    const [vector] = await h.deps.embedder.embed(['onboarding price'], {
      purpose: 'query',
      signal: new AbortController().signal,
    })
    await h.deps.vectors.upsert(h.organizationId, [
      {
        id: 'planted:0',
        vector: vector ?? [],
        attributes: {
          document_id: theirs.id,
          epoch: 0,
          chunk: 0,
          page: 1,
          snippet: 'LEAKED-DOCUMENT-TEXT',
          kind: 'document',
          v: 2,
        },
      },
    ])

    const response = await search(h, ask('onboarding price'))
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).not.toContain('LEAKED')
    expect(text).not.toContain(theirs.id)
  })
})
