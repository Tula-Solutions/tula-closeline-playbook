import { describe, expect, test } from 'bun:test'
import {
  callSchema,
  MAX_SEARCH_CANDIDATES,
  momentSnippet,
  searchMomentsResponseSchema,
} from 'tula-closeline-contract'
import { CALLS, type CallHarness, createCallHarness } from '~/modules/call/test-support'
import { errorCode, personIn } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'

const SEARCH = '/v1/playbook/search/moments'
const PROSPECT_LINE = 'We are worried about the price of onboarding for the whole team'

/** A Transcript whose Prospect says `line`, with a Rep who answers it. */
const conversation = (line: string, answer = 'We can cut onboarding in half with a guided plan') =>
  `Alex: Thanks for joining today.\nSam: ${line}\nAlex: ${answer}\n`

/** Uploads a Transcript for a Deal, processes it, and returns the Call. */
async function ready(h: CallHarness, dealId: string, text: string, as = h.people.owner) {
  const response = await h.uploadCall(text, { dealId, as })
  expect(response.status).toBe(201)
  const call = callSchema.parse(await response.json())
  await settle(h)
  return call
}

/** Runs every job, the Outcome re-tag included, until none is left. */
async function settle(h: CallHarness) {
  for (let pass = 0; pass < 50; pass++) {
    if ((await h.deps.workers.ingestion.runPass()) === 0) {
      break
    }
  }
}

/** A Call of a Deal that is `won`, its vectors tagged. */
async function wonCall(h: CallHarness, dealId: string, text: string, as = h.people.owner) {
  const call = await ready(h, dealId, text, as)
  const response = await h.send('PUT', `/v1/playbook/deals/${call.dealRecordId}/outcome`, {
    body: { outcome: 'won' },
    as,
  })
  expect(response.status).toBe(200)
  await settle(h)
  return call
}

const search = (h: CallHarness, body: unknown, options: Parameters<CallHarness['send']>[2] = {}) =>
  h.send('POST', SEARCH, { body, ...options })

const ask = (text: string, limit?: number) => ({
  turns: [{ role: 'prospect', text }],
  ...(limit === undefined ? {} : { limit }),
})

describe('who may search', () => {
  test('needs a token and an Owner or Admin: a Manager and a Rep get 403', async () => {
    const h = await createCallHarness()

    expect((await search(h, ask('price'), { as: null })).status).toBe(401)
    for (const role of ['manager', 'rep'] as const) {
      const denied = await search(h, ask('price'), { as: h.people[role] })
      expect(denied.status).toBe(403)
      expect(await errorCode(denied)).toBe('auth.forbidden')
    }
    for (const role of ['owner', 'admin'] as const) {
      expect((await search(h, ask('price'), { as: h.people[role] })).status).toBe(200)
    }
  })

  test('is not under the Call routes: the path is the contract path', () => {
    expect(SEARCH).toBe('/v1/playbook/search/moments')
    expect(CALLS).not.toContain('search')
  })
})

describe('what a search returns', () => {
  test('a Moment of a won Deal, with its snippets, the opaque ids and the evidence', async () => {
    const h = await createCallHarness()
    const call = await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))

    const response = await search(h, ask('worried about the price of onboarding'))

    expect(response.status).toBe(200)
    const body = searchMomentsResponseSchema.parse(await response.json())
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      callId: call.id,
      dealRecordId: call.dealRecordId,
      prospect: momentSnippet(PROSPECT_LINE),
      repNext: momentSnippet('We can cut onboarding in half with a guided plan'),
    })
    expect(body.evidence).toEqual({ moments: 1, deals: 1 })
    // Nothing of the customer's: no deal id, name or amount, and no other key.
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(
      ['callId', 'dealRecordId', 'prospect', 'repNext', 'score'].sort()
    )
    expect(JSON.stringify(body)).not.toContain('WON-1')
  })

  test('embeds the query once, as a query, with the contract text', async () => {
    const h = await createCallHarness()
    await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))
    h.deps.embedder.calls.length = 0

    await search(h, {
      turns: [
        { role: 'rep', text: '  Hello again  ' },
        { role: 'prospect', text: ' the price worries me ' },
      ],
    })

    expect(h.deps.embedder.calls).toEqual([
      { texts: ['Rep: Hello again\nProspect: the price worries me'], purpose: 'query' },
    ])
  })

  test('a Call of an open or a lost Deal is never returned', async () => {
    const h = await createCallHarness()
    await ready(h, 'OPEN-1', conversation(PROSPECT_LINE))
    const lost = await ready(
      h,
      'LOST-1',
      conversation(PROSPECT_LINE, 'We could offer a discount on the first year')
    )
    await h.setOutcome(lost.dealRecordId, 'lost')
    await settle(h)

    const body = searchMomentsResponseSchema.parse(
      await (await search(h, ask('worried about the price of onboarding'))).json()
    )

    expect(body.items).toEqual([])
    expect(body.evidence).toEqual({ moments: 0, deals: 0 })
  })

  test('a Deal that went from won to lost is dropped at once, before the re-tag has run', async () => {
    const h = await createCallHarness()
    const call = await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))
    await h.setOutcome(call.dealRecordId, 'lost')
    // The vectors still say won: only Postgres knows.

    const body = searchMomentsResponseSchema.parse(
      await (await search(h, ask('worried about the price of onboarding'))).json()
    )

    expect(body.items).toEqual([])
  })

  test('a deleted Call is not returned', async () => {
    const h = await createCallHarness()
    const call = await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))
    expect((await h.send('DELETE', `${CALLS}/${call.id}`)).status).toBe(200)

    const body = searchMomentsResponseSchema.parse(
      await (await search(h, ask('worried about the price of onboarding'))).json()
    )

    expect(body.items).toEqual([])
  })

  test('vectors written before the snippets existed (no v: 2) are ignored', async () => {
    const h = await createCallHarness()
    const call = await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))
    const hits = await h.deps.vectors.search(h.organizationId, {
      vector: new Array<number>(h.deps.embedder.dimensions).fill(0.1),
      topK: 100,
      filter: { call_id: call.id },
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

    const body = searchMomentsResponseSchema.parse(
      await (await search(h, ask('worried about the price of onboarding'))).json()
    )

    expect(body.items).toEqual([])
  })

  test('limit cuts the items, best first; evidence still counts the whole candidate window', async () => {
    const h = await createCallHarness()
    for (let i = 0; i < 4; i++) {
      await wonCall(h, `WON-${i}`, conversation(`${PROSPECT_LINE} number ${i}`, `answer ${i}`))
    }

    const all = searchMomentsResponseSchema.parse(
      await (await search(h, ask('worried about the price of onboarding', 20))).json()
    )
    const one = searchMomentsResponseSchema.parse(
      await (await search(h, ask('worried about the price of onboarding', 1))).json()
    )

    expect(all.items).toHaveLength(4)
    expect(all.items.map((i) => i.score)).toEqual(
      [...all.items.map((i) => i.score)].sort((a, b) => b - a)
    )
    expect(one.items).toHaveLength(1)
    expect(one.items[0]?.callId).toBe(all.items[0]?.callId)
    expect(one.evidence).toEqual({ moments: 4, deals: 4 })
    expect(all.evidence).toEqual({ moments: 4, deals: 4 })
  })

  test('evidence counts a Deal once however many of its Moments match', async () => {
    const h = await createCallHarness()
    const text = `Alex: Hi.\nSam: ${PROSPECT_LINE}\nAlex: One moment.\nSam: ${PROSPECT_LINE} again\nAlex: Noted.\n`
    await wonCall(h, 'WON-1', text)

    const body = searchMomentsResponseSchema.parse(
      await (await search(h, ask('worried about the price of onboarding'))).json()
    )

    expect(body.evidence).toEqual({ moments: 2, deals: 1 })
    expect(new Set(body.items.map((i) => i.dealRecordId)).size).toBe(1)
  })

  test('asks the vector store for min(100, limit x 5) candidates, won and v 2 only', async () => {
    const h = await createCallHarness()
    const seen: { topK: number; filter: unknown }[] = []
    const base = h.deps.vectors.search.bind(h.deps.vectors)
    h.deps.vectors.search = async (organizationId, query) => {
      seen.push({ topK: query.topK, filter: query.filter })
      return base(organizationId, query)
    }

    await search(h, ask('price', 3))
    await search(h, ask('price', 20))

    expect(seen).toEqual([
      { topK: 15, filter: { outcome: 'won', v: 2 } },
      { topK: MAX_SEARCH_CANDIDATES, filter: { outcome: 'won', v: 2 } },
    ])
  })
})

describe('what a search refuses', () => {
  test.each([
    ['no turns', { turns: [] }],
    ['seven turns', { turns: Array.from({ length: 7 }, () => ({ role: 'rep', text: 'x' })) }],
    ['a limit of 0', ask('price', 0)],
    ['a limit of 21', ask('price', 21)],
    ['a non-integer limit', { ...ask('price'), limit: 1.5 }],
    ['more than 2000 characters', ask('x'.repeat(2001))],
    [
      'more than 2000 characters across two turns',
      {
        turns: [
          { role: 'rep', text: 'x'.repeat(1000) },
          { role: 'prospect', text: 'y'.repeat(1001) },
        ],
      },
    ],
    ['a turn of whitespace only', ask('   \n\t ')],
    ['an empty turn', ask('')],
    ['an unknown role', { turns: [{ role: 'agent', text: 'hi' }] }],
    ['an unknown key', { ...ask('price'), topK: 5 }],
    ['an unknown key in a turn', { turns: [{ role: 'rep', text: 'hi', speaker: 'A' }] }],
    ['a body that is not an object', 'price'],
  ])('%s is request.invalid', async (_label, body) => {
    const h = await createCallHarness()

    const response = await search(h, body)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('request.invalid')
    expect(h.deps.embedder.calls).toEqual([])
  })

  test('exactly 2000 characters and six turns are accepted', async () => {
    const h = await createCallHarness()

    const long = await search(h, ask('x'.repeat(2000)))
    const six = await search(h, {
      turns: Array.from({ length: 6 }, () => ({ role: 'rep', text: 'x' })),
    })

    expect(long.status).toBe(200)
    expect(six.status).toBe(200)
  })
})

describe('when the model or the store cannot answer', () => {
  test('an embedder that fails is 503 server.unavailable with Retry-After, and nothing is logged of the text', async () => {
    const h = await createCallHarness()
    h.deps.embedder.embed = async () => {
      throw new Error('the model is down: SECRET-QUERY-TEXT')
    }

    const response = await search(h, ask('SECRET-QUERY-TEXT about price'))

    expect(response.status).toBe(503)
    expect(await errorCode(response)).toBe('server.unavailable')
    expect(response.headers.get('retry-after')).not.toBeNull()
    expect(h.deps.logLines.join('\n')).not.toContain('SECRET-QUERY-TEXT')
  })

  test('a vector store that fails is 503 with Retry-After', async () => {
    const h = await createCallHarness()
    h.deps.vectors.search = async () => {
      throw new Error('the store is down')
    }

    const response = await search(h, ask('price'))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).not.toBeNull()
  })

  test.each([
    ['the embedder', 'embedder'],
    ['the vector store', 'vectors'],
  ] as const)('%s that never answers is cut off: 504 server.timeout', async (_label, which) => {
    const h = await createCallHarness()
    if (which === 'embedder') {
      h.deps.embedder.embed = () => new Promise(() => undefined)
    } else {
      h.deps.vectors.search = () => new Promise(() => undefined)
    }

    const pending = search(h, ask('price'))
    for (let tick = 0; tick < 20; tick++) {
      await Bun.sleep(0)
      await h.deps.time.advance(h.deps.env.SEARCH_STEP_TIMEOUT_MS + 1)
    }
    const response = await pending

    expect(response.status).toBe(504)
    expect(await errorCode(response)).toBe('server.timeout')
  })

  test('a database read that never answers is cut off: 504 server.timeout', async () => {
    const h = await createCallHarness()
    await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))
    h.deps.scope = () => new Promise(() => undefined)

    const pending = search(h, ask('worried about the price of onboarding'))
    for (let tick = 0; tick < 20; tick++) {
      await Bun.sleep(0)
      await h.deps.time.advance(h.deps.env.SEARCH_STEP_TIMEOUT_MS + 1)
    }
    const response = await pending

    expect(response.status).toBe(504)
    expect(await errorCode(response)).toBe('server.timeout')
  })

  test('a database that cancels the read at its statement timeout is 504 server.timeout', async () => {
    const h = await createCallHarness()
    await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))
    h.deps.scope = async () => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      })
    }

    const response = await search(h, ask('worried about the price of onboarding'))

    expect(response.status).toBe(504)
    expect(await errorCode(response)).toBe('server.timeout')
  })

  test('a lost database connection is 503 with Retry-After', async () => {
    const h = await createCallHarness()
    await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))
    h.deps.scope = async () => {
      throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' })
    }

    const response = await search(h, ask('worried about the price of onboarding'))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).not.toBeNull()
  })

  test('a database error that a repeat cannot cure is a 500, not a 503', async () => {
    const h = await createCallHarness()
    await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))
    h.deps.scope = async () => {
      throw new Error('syntax error')
    }

    expect((await search(h, ask('worried about the price of onboarding'))).status).toBe(500)
  })

  test('the read sets a statement timeout of the step deadline first, in its own transaction', async () => {
    const h = await createCallHarness()
    await wonCall(h, 'WON-1', conversation(PROSPECT_LINE))
    const before = h.deps.database.transactionStatements.length

    await search(h, ask('worried about the price of onboarding'))

    const [statements] = h.deps.database.transactionStatements.slice(before)
    expect(statements?.[0]).toBe(
      `set local statement_timeout = '${h.deps.env.SEARCH_STEP_TIMEOUT_MS}ms'`
    )
  })

  test('a model that answers a vector of the wrong length is 503, not a crash', async () => {
    const h = await createCallHarness()
    h.deps.embedder.embed = async () => [[1, 0, 0]]

    expect((await search(h, ask('price'))).status).toBe(503)
  })
})

describe('a second Organization', () => {
  /** Two Organizations with the same won conversation. */
  async function twoOrganizations() {
    const h = await createCallHarness()
    const otherId = newOrganizationId()
    h.confirmRights(otherId)
    const stranger = personIn(otherId, 'owner')
    const mine = await wonCall(h, 'DEAL-A', conversation(PROSPECT_LINE))
    const theirs = await wonCall(h, 'DEAL-B', conversation(PROSPECT_LINE), stranger)
    return { h, stranger, otherId, mine, theirs }
  }

  test('gets only its own results from identical text, and the first sees only its own', async () => {
    const { h, stranger, mine, theirs } = await twoOrganizations()

    const first = searchMomentsResponseSchema.parse(
      await (await search(h, ask('worried about the price of onboarding'))).json()
    )
    const second = searchMomentsResponseSchema.parse(
      await (await search(h, ask('worried about the price of onboarding'), { as: stranger })).json()
    )

    expect(first.items.map((i) => i.callId)).toEqual([mine.id])
    expect(second.items.map((i) => i.callId)).toEqual([theirs.id])
    expect(first.evidence).toEqual({ moments: 1, deals: 1 })
    expect(second.evidence).toEqual({ moments: 1, deals: 1 })
  })

  test("the vector store is only ever searched in the caller's Organization", async () => {
    const { h, stranger, otherId } = await twoOrganizations()
    const namespaces: string[] = []
    const base = h.deps.vectors.search.bind(h.deps.vectors)
    h.deps.vectors.search = async (organizationId, query) => {
      namespaces.push(organizationId)
      return base(organizationId, query)
    }

    await search(h, ask('price'))
    await search(h, ask('price'), { as: stranger })

    expect(namespaces).toEqual([h.organizationId, otherId])
  })

  test("a foreign call id planted in the caller's namespace is dropped, and its text never returned", async () => {
    const { h, theirs } = await twoOrganizations()
    const [vector] = await h.deps.embedder.embed(
      ['Prospect: worried about the price of onboarding'],
      { purpose: 'query', signal: new AbortController().signal }
    )
    // The best possible hit, in the caller's namespace, but it names the other Organization's Call.
    await h.deps.vectors.upsert(h.organizationId, [
      {
        id: `${theirs.id.slice('call_'.length)}:0:0:99`,
        vector: vector ?? [],
        attributes: {
          call_id: theirs.id,
          epoch: 0,
          rep_seq: 0,
          moment: 99,
          outcome: 'won',
          outcome_seq: 1,
          prospect: 'LEAKED-PROSPECT-TEXT',
          rep_next: 'LEAKED-REP-TEXT',
          v: 2,
        },
      },
    ])

    const response = await search(h, ask('worried about the price of onboarding'))
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).not.toContain('LEAKED')
    expect(text).not.toContain(theirs.id)
  })
})
