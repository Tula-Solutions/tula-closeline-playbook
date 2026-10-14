import { describe, expect, test } from 'bun:test'
import { dealSchema, encodeCursor, listDealsResponseSchema } from 'tula-closeline-contract'
import { DEAL_LIST, DEAL_SET_OUTCOME } from 'tula-closeline-db'
import { MEMORY_DEAL_MAX_SEQ, postgresError } from '~/adapters/memory/playbook-database'
import { describeError } from '~/describe-error'
import { createDocumentHarness, errorCode, personIn } from '~/modules/document/test-support'
import { newOrganizationId, type TestIdentity } from '~/testing'

const DEALS = '/v1/playbook/deals'
const deal = (n: number) => `deal_${n.toString(16).padStart(32, '0')}`
/** A customer deal id nothing may ever print. */
const SECRET_DEAL_ID = 'ACME-RENEWAL-2026-SECRET'

async function harness() {
  const h = await createDocumentHarness()
  const send = async (
    method: string,
    path: string,
    options: { as?: TestIdentity | null; body?: unknown } = {}
  ) => {
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
  const seed = (
    n: number,
    extra: Record<string, unknown> = {},
    organizationId = h.organizationId
  ) =>
    h.deps.database.seedDeal({
      id: deal(n),
      organization_id: organizationId,
      deal_id: `D-${n}`,
      ...extra,
    })
  return { h, send, seed }
}

describe('who may use the Deal routes', () => {
  test.each([
    ['GET', DEALS, undefined],
    ['GET', `${DEALS}/${deal(1)}`, undefined],
    ['POST', `${DEALS}/lookup`, { dealId: 'D-1' }],
    ['PUT', `${DEALS}/${deal(1)}/outcome`, { outcome: 'won' }],
  ])('%s %s needs a token and an Owner or Admin', async (method, path, body) => {
    const { h, send, seed } = await harness()
    seed(1)

    expect((await send(method, path, { as: null, body })).status).toBe(401)
    for (const role of ['manager', 'rep'] as const) {
      const denied = await send(method, path, { as: h.people[role], body })
      expect(denied.status).toBe(403)
      expect(await errorCode(denied)).toBe('auth.forbidden')
    }
    expect((await send(method, path, { as: h.people.admin, body })).status).toBe(200)
    expect((await send(method, path, { as: h.people.owner, body })).status).toBe(200)
  })

  test('a second Organization can neither read nor change the Deals of the first', async () => {
    const { h, send, seed } = await harness()
    seed(1, { outcome: 'open' })
    const stranger = personIn(newOrganizationId(), 'owner')

    const read = await send('GET', `${DEALS}/${deal(1)}`, { as: stranger })
    const found = await send('POST', `${DEALS}/lookup`, { as: stranger, body: { dealId: 'D-1' } })
    const changed = await send('PUT', `${DEALS}/${deal(1)}/outcome`, {
      as: stranger,
      body: { outcome: 'won' },
    })
    const listed = listDealsResponseSchema.parse(
      await (await send('GET', DEALS, { as: stranger })).json()
    )

    expect(read.status).toBe(404)
    expect(await errorCode(read)).toBe('deal.not_found')
    expect(found.status).toBe(404)
    expect(changed.status).toBe(404)
    expect(listed.items).toEqual([])
    expect(h.deps.database.deals(h.organizationId)[0]).toMatchObject({
      outcome: 'open',
      outcome_seq: 0,
    })
    expect(h.published).toEqual([])
  })
})

describe('bad requests are refused with request.invalid', () => {
  test.each([
    ['a Deal id that is not a record id', 'GET', `${DEALS}/D-1`, undefined],
    ['a cursor that is not one', 'GET', `${DEALS}?cursor=not-a-cursor`, undefined],
    ['an unknown Outcome filter', 'GET', `${DEALS}?outcome=maybe`, undefined],
    ['both filters at once', 'GET', `${DEALS}?outcome=won&appearedInImport=true`, undefined],
    ['an unknown query key', 'GET', `${DEALS}?dealId=D-1`, undefined],
    ['a lookup with no deal id', 'POST', `${DEALS}/lookup`, {}],
    ['a lookup with an extra key', 'POST', `${DEALS}/lookup`, { dealId: 'D-1', name: 'x' }],
    ['a lookup with control characters', 'POST', `${DEALS}/lookup`, { dealId: 'a\u0000b' }],
    ['an Outcome that is not one', 'PUT', `${DEALS}/${deal(1)}/outcome`, { outcome: 'pending' }],
    [
      'a closing date that is not a date',
      'PUT',
      `${DEALS}/${deal(1)}/outcome`,
      { outcome: 'won', closedAt: 'yesterday' },
    ],
    [
      'a closing date with a time',
      'PUT',
      `${DEALS}/${deal(1)}/outcome`,
      { outcome: 'won', closedAt: '2026-03-01T00:00:00Z' },
    ],
    [
      'a closing date that is not a real day',
      'PUT',
      `${DEALS}/${deal(1)}/outcome`,
      { outcome: 'won', closedAt: '2026-02-30' },
    ],
    [
      'an extra key in an Outcome request',
      'PUT',
      `${DEALS}/${deal(1)}/outcome`,
      { outcome: 'won', amount: '1' },
    ],
  ])('%s', async (_label, method, path, body) => {
    const { send, seed } = await harness()
    seed(1)

    const response = await send(method, path, { body })

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('request.invalid')
  })

  test('a database that rejects the cursor text (SQLSTATE 22007) is request.invalid, not a 500', async () => {
    const { h, send } = await harness()
    h.deps.database.failNext(DEAL_LIST, postgresError('22007'))

    const response = await send('GET', DEALS)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('request.invalid')
  })

  test.each([
    ['year zero', '0000-01-01T00:00:00+00:00'],
    ['a day the month does not have', '2026-02-30T00:00:00+00:00'],
    ['an hour out of range', '2026-01-01T25:00:00+00:00'],
  ])(
    'a cursor time with %s is request.invalid on every list, and is never echoed',
    async (_label, createdAt) => {
      const { h, send, seed } = await harness()
      seed(1)
      const cursor = encodeURIComponent(encodeCursor({ createdAt, id: deal(1) } as never))

      for (const filter of ['', '&outcome=won', '&appearedInImport=true']) {
        const response = await send('GET', `${DEALS}?cursor=${cursor}${filter}`)
        const text = await response.text()

        expect(response.status).toBe(400)
        expect(JSON.parse(text).error.code).toBe('request.invalid')
        expect(text).not.toContain(createdAt)
      }
      const logged = [
        ...h.deps.logLines,
        JSON.stringify(h.deps.reported.map((r) => String(r.error))),
      ].join('\n')
      expect(logged).not.toContain(createdAt)
      expect(h.deps.reported).toEqual([])
    }
  )

  test('an error of SQLSTATE class 22 from a list (here 22008) is request.invalid, not a 500', async () => {
    const { h, send } = await harness()
    h.deps.database.failNext(DEAL_LIST, postgresError('22008', 'secret cursor text'))

    const response = await send('GET', DEALS)
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(JSON.parse(text).error.code).toBe('request.invalid')
    expect(text).not.toContain('secret cursor text')
    expect(h.deps.reported).toEqual([])
  })

  test('a class 23 error (a check constraint) is still a server error, not request.invalid', async () => {
    const { h, send } = await harness()
    h.deps.database.failNext(DEAL_LIST, postgresError('23514'))

    expect((await send('GET', DEALS)).status).toBe(500)
    expect(h.deps.reported).toHaveLength(1)
  })

  test('a missing Deal is deal.not_found for a read and for an Outcome change', async () => {
    const { send } = await harness()

    for (const [method, path, body] of [
      ['GET', `${DEALS}/${deal(404)}`, undefined],
      ['PUT', `${DEALS}/${deal(404)}/outcome`, { outcome: 'won' }],
      ['POST', `${DEALS}/lookup`, { dealId: 'nope' }],
    ] as const) {
      const response = await send(method, path, { body })
      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('deal.not_found')
    }
  })
})

describe('listing Deals', () => {
  test('pages newest first by the statement text cursor, so Deals created together are not skipped', async () => {
    const { h, send, seed } = await harness()
    const base = Date.parse('2026-01-01T00:00:00Z') * 1000
    for (const [n, offset] of [
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
    ] as const) {
      seed(n, { created_at_us: base + offset })
    }

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const response = await send(
        'GET',
        `${DEALS}?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      )
      const body = listDealsResponseSchema.parse(await response.json())
      seen.push(...body.items.map((item) => item.id))
      cursor = body.nextCursor
      if (cursor === null) {
        break
      }
    }

    expect(seen).toEqual([deal(5), deal(4), deal(3), deal(2), deal(1)])
    expect(h.deps.database.deals(h.organizationId)).toHaveLength(5)
  })

  test('filters by Outcome and by whether the Deal appeared in an import', async () => {
    const { send, seed } = await harness()
    seed(1, { outcome: 'won', appeared_in_import: true })
    seed(2, { outcome: 'lost' })
    seed(3, { outcome: 'open', appeared_in_import: true })

    const won = listDealsResponseSchema.parse(
      await (await send('GET', `${DEALS}?outcome=won`)).json()
    )
    const never = listDealsResponseSchema.parse(
      await (await send('GET', `${DEALS}?appearedInImport=false`)).json()
    )

    expect(won.items.map((d) => String(d.id))).toEqual([deal(1)])
    expect(never.items.map((d) => String(d.id))).toEqual([deal(2)])
  })

  test('the answer carries the contract fields only: no sequence, no Organization', async () => {
    const { send, seed } = await harness()
    seed(1, { name: 'Acme', amount: '10.00', currency: 'EUR', outcome: 'won' })

    const body = (await (await send('GET', `${DEALS}/${deal(1)}`)).json()) as Record<
      string,
      unknown
    >

    expect(Object.keys(body).sort()).toEqual(Object.keys(dealSchema.shape).sort())
    expect(body).toMatchObject({ dealId: 'D-1', name: 'Acme', amount: '10.00', callCount: 0 })
  })
})

describe('a row the database returns that breaks the contract', () => {
  test('is a generic 500 and no row value reaches the log or the error report', async () => {
    const { h, send, seed } = await harness()
    seed(1, {
      deal_id: ` ${SECRET_DEAL_ID} `,
      name: `SECRET-NAME-${'x'.repeat(300)}`,
      amount: 'SECRET-AMOUNT',
      currency: 'SECRET-CUR',
      outcome: 'SECRET-OUTCOME' as never,
    })

    const response = await send('GET', `${DEALS}/${deal(1)}`)
    const listed = await send('GET', DEALS)

    expect(response.status).toBe(500)
    expect(listed.status).toBe(500)
    const everything = [
      await response.clone().text(),
      ...h.deps.logLines,
      ...h.deps.reported.map((r) => JSON.stringify(describeError(r.error))),
      // The reporter receives the error itself, so its own text and issue list are checked too.
      ...h.deps.reported.map((r) => String((r.error as Error).message)),
      ...h.deps.reported.map((r) => JSON.stringify(r.error)),
    ].join('\n')
    expect(h.deps.reported.length).toBeGreaterThan(0)
    for (const secret of [
      SECRET_DEAL_ID,
      'SECRET-NAME',
      'SECRET-AMOUNT',
      'SECRET-CUR',
      'SECRET-OUTCOME',
    ]) {
      expect(everything).not.toContain(secret)
    }
  })
})

describe('looking a Deal up by the customer id', () => {
  test('finds it exactly, in the body, and never prints the id', async () => {
    const { h, send, seed } = await harness()
    seed(1, { deal_id: SECRET_DEAL_ID })

    const found = await send('POST', `${DEALS}/lookup`, { body: { dealId: ` ${SECRET_DEAL_ID} ` } })
    const folded = await send('POST', `${DEALS}/lookup`, {
      body: { dealId: SECRET_DEAL_ID.toLowerCase() },
    })

    expect(found.status).toBe(200)
    expect(String(dealSchema.parse(await found.json()).id)).toBe(deal(1))
    expect(folded.status).toBe(404)
    const output = [
      ...h.deps.logLines,
      JSON.stringify(h.deps.reported.map((r) => String(r.error))),
    ].join('\n')
    expect(output).not.toContain(SECRET_DEAL_ID)
    expect(output.toLowerCase()).not.toContain(SECRET_DEAL_ID.toLowerCase())
  })

  test('an error answer for a lookup does not echo the id either', async () => {
    const { send } = await harness()

    const response = await send('POST', `${DEALS}/lookup`, {
      body: { dealId: `${SECRET_DEAL_ID}\u0000` },
    })

    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(SECRET_DEAL_ID)
  })
})

describe('setting an Outcome', () => {
  test('a change moves the sequence once and publishes one message; a repeat publishes nothing', async () => {
    const { h, send, seed } = await harness()
    seed(1)

    const first = await send('PUT', `${DEALS}/${deal(1)}/outcome`, {
      body: { outcome: 'won', closedAt: '2026-03-01' },
    })
    const again = await send('PUT', `${DEALS}/${deal(1)}/outcome`, {
      body: { outcome: 'won', closedAt: '2026-03-01' },
    })

    expect(first.status).toBe(200)
    expect(dealSchema.parse(await first.json())).toMatchObject({
      outcome: 'won',
      closedAt: '2026-03-01',
    })
    expect(again.status).toBe(200)
    expect(h.deps.database.deals(h.organizationId)[0]?.outcome_seq).toBe(1)
    expect(h.published).toHaveLength(1)
    expect(h.published[0]).toMatchObject({
      type: 'playbook.deal_outcome_changed',
      organizationId: h.organizationId,
      payload: { dealRecordId: deal(1), outcomeSeq: 1 },
    })
  })

  test('a date reads back as the same date in a time zone behind UTC', async () => {
    const { send, seed } = await harness()
    seed(1)
    const zone = process.env.TZ
    process.env.TZ = 'America/Chicago'
    try {
      const set = await send('PUT', `${DEALS}/${deal(1)}/outcome`, {
        body: { outcome: 'won', closedAt: '2026-01-31' },
      })
      const read = await send('GET', `${DEALS}/${deal(1)}`)

      expect(dealSchema.parse(await set.json()).closedAt).toBe('2026-01-31')
      expect(dealSchema.parse(await read.json()).closedAt).toBe('2026-01-31')
    } finally {
      if (zone === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = zone
      }
    }
  })

  test('a closing time alone counts as a change, and null clears it', async () => {
    const { h, send, seed } = await harness()
    seed(1, { outcome: 'won', closed_at: '2026-01-01', outcome_seq: 1 })

    await send('PUT', `${DEALS}/${deal(1)}/outcome`, { body: { outcome: 'won', closedAt: null } })

    expect(h.deps.database.deals(h.organizationId)[0]).toMatchObject({
      closed_at: null,
      outcome_seq: 2,
    })
    expect(h.published).toHaveLength(1)
  })

  test('an Outcome request without a closing time leaves the closing time alone', async () => {
    const { h, send, seed } = await harness()
    const closed = '2026-01-01'
    seed(1, { outcome: 'open', closed_at: closed })

    await send('PUT', `${DEALS}/${deal(1)}/outcome`, { body: { outcome: 'lost' } })

    expect(h.deps.database.deals(h.organizationId)[0]).toMatchObject({
      outcome: 'lost',
      closed_at: closed,
    })
  })

  test('a publish that fails does not undo or hide the change, and the log holds ids only', async () => {
    const { h, send, seed } = await harness()
    seed(1, { deal_id: SECRET_DEAL_ID, name: 'Acme Secret Name' })
    const publish = h.deps.queue.publish.bind(h.deps.queue)
    h.deps.queue.publish = async () => {
      throw new Error('the queue is down')
    }

    const response = await send('PUT', `${DEALS}/${deal(1)}/outcome`, { body: { outcome: 'won' } })

    expect(response.status).toBe(200)
    expect(h.deps.database.deals(h.organizationId)[0]).toMatchObject({
      outcome: 'won',
      outcome_seq: 1,
    })
    const logged = h.deps.logLines.join('\n')
    expect(logged).toContain('re-tag job recovers from outcome_seq')
    expect(logged).toContain(deal(1))
    expect(logged).not.toContain(SECRET_DEAL_ID)
    expect(logged).not.toContain('Acme Secret Name')
    h.deps.queue.publish = publish
  })

  test('a Deal at the sequence ceiling is an accepted unclassified 500: nothing changes, nothing is published', async () => {
    const { h, send, seed } = await harness()
    seed(1, { outcome: 'open', outcome_seq: MEMORY_DEAL_MAX_SEQ })

    const response = await send('PUT', `${DEALS}/${deal(1)}/outcome`, { body: { outcome: 'won' } })

    expect(response.status).toBe(500)
    expect(h.deps.database.deals(h.organizationId)[0]).toMatchObject({ outcome: 'open' })
    expect(h.published).toEqual([])
  })

  test('a lock timeout is a retryable 503 and nothing is published', async () => {
    const { h, send, seed } = await harness()
    seed(1)
    h.deps.database.failNext(DEAL_SET_OUTCOME, postgresError('55P03'))

    const response = await send('PUT', `${DEALS}/${deal(1)}/outcome`, { body: { outcome: 'won' } })

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(h.published).toEqual([])
  })
})
