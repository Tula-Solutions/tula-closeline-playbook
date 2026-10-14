import { describe, expect, test } from 'bun:test'
import { callSchema } from 'tula-closeline-contract'
import { personIn } from '~/modules/document/test-support'
import { logged } from '~/modules/ingestion/test-support'
import { momentVectorId } from './keys'
import { cleanupPendingCalls } from './purge'
import { RETAG_DEALS_PER_PASS, retagOutcomes } from './retag'
import { type CallHarness, createCallHarness, transcriptText } from './test-support'

const never = new AbortController().signal

async function readyCall(h: CallHarness, seed: string, dealId = 'DEAL-1') {
  const response = await h.uploadCall(transcriptText(seed, 2), { dealId })
  expect(response.status).toBe(201)
  const call = callSchema.parse(await response.json())
  await h.runCalls()
  expect((await h.readCall(call.id)).state).toBe('ready')
  return call
}

const dealOf = (h: CallHarness, index = 0) => {
  const deal = h.deps.database.deals(h.organizationId)[index]
  if (deal === undefined) {
    throw new Error('no Deal')
  }
  return deal
}

/** One pass of the job loop, which includes the Outcome re-tag of every Organization discovery names. */
const pass = (h: CallHarness) => h.deps.workers.ingestion.runPass()

describe('the Outcome re-tag is found by discovery, not by a message', () => {
  test('an Outcome changed with no handler running is re-tagged by the next pass, and the Call becomes returnable', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    expect(await h.moments(call.id)).toMatchObject({ total: 2, returnable: 0, outcomes: ['open'] })
    const published = h.published.length

    await h.setOutcome(dealOf(h).id, 'won')
    // Nothing consumes the Outcome-changed message in this test: drop whatever was published.
    h.published.length = published
    expect(await h.moments(call.id)).toMatchObject({ returnable: 0, outcomes: ['open'] })
    await pass(h)

    expect(await h.moments(call.id)).toMatchObject({ total: 2, returnable: 2, outcomes: ['won'] })
    expect((await h.readCall(call.id)).inSearch).toBe(true)
    expect(dealOf(h).retag_through).toBe(dealOf(h).outcome_seq)
    expect(h.deps.database.discoveries.some((d) => d.kind === 'outcome_retag')).toBe(true)
  })

  test('a Deal changed before the job existed (hint rows from long ago) is recovered', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'old')
    Object.assign(dealOf(h), { outcome: 'won', outcome_seq: 3, retag_through: 0 })

    await pass(h)

    expect(await h.moments(call.id)).toMatchObject({ returnable: 2, outcomes: ['won'] })
    expect(dealOf(h).retag_through).toBe(3)
  })

  test('the Outcome-changed message only nudges the same code path', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'nudge')
    await h.setOutcome(dealOf(h).id, 'won')
    const message = h.published.at(-1)
    expect(message?.type).toBe('playbook.deal_outcome_changed')
    const nudged: string[] = []
    const { ingestionHandlers } = await import('~/modules/ingestion/handlers')
    const handlers = ingestionHandlers(h.deps, (organizationId) => nudged.push(organizationId))

    await handlers['playbook.deal_outcome_changed']?.(
      message as never,
      {
        organizationId: h.organizationId,
        signal: never,
      } as never
    )

    expect(nudged).toEqual([h.organizationId])
    await pass(h)
    expect((await h.moments(call.id)).returnable).toBe(2)
  })
})

describe('search eligibility follows real state through open, won, lost and won again', () => {
  test('a Moment is never returnable while the Deal is open or lost, even before the re-tag, and only once the tag is current when won', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'cycle')
    const id = dealOf(h).id
    const state = () => h.moments(call.id)

    expect((await state()).returnable).toBe(0) // open

    await h.setOutcome(id, 'won') // re-tag held back
    expect((await state()).returnable).toBe(0)
    await pass(h)
    expect(await state()).toMatchObject({ returnable: 2, outcomes: ['won'] })

    await h.setOutcome(id, 'lost') // vectors still say won; Postgres knows better at once
    expect(await state()).toMatchObject({ returnable: 0, outcomes: ['won'] })
    await pass(h)
    expect(await state()).toMatchObject({ returnable: 0, outcomes: ['lost'] })

    await h.setOutcome(id, 'won') // re-tag held back again
    expect((await state()).returnable).toBe(0)
    await pass(h)
    expect(await state()).toMatchObject({ returnable: 2, outcomes: ['won'] })
  })

  test('won then lost then won with no re-tag between never lets a stale tag through', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'flap')
    const id = dealOf(h).id
    await h.setOutcome(id, 'won')
    await pass(h)
    await h.setOutcome(id, 'lost')
    await h.setOutcome(id, 'won')

    // The vectors say won (seq 1) and the Deal is won again (seq 3): the Call is not current.
    expect(await h.moments(call.id)).toMatchObject({ returnable: 0, outcomes: ['won'] })
    await pass(h)
    expect((await h.moments(call.id)).returnable).toBe(2)
  })

  test('a Call whose Outcome changed during processing is out of search, and the re-tag repairs it', async () => {
    const h = await createCallHarness()
    const response = await h.uploadCall(transcriptText('race', 2), { dealId: 'DEAL-R' })
    const call = callSchema.parse(await response.json())
    const embed = h.deps.embedder.embed.bind(h.deps.embedder)
    let changed = false
    h.deps.embedder.embed = async (...args) => {
      if (!changed) {
        changed = true
        await h.setOutcome(dealOf(h).id, 'won')
      }
      return embed(...args)
    }

    await h.runCalls()

    const ready = await h.readCall(call.id)
    expect(ready).toMatchObject({ state: 'ready', dealOutcome: 'won', inSearch: false })
    expect(await h.moments(call.id)).toMatchObject({ returnable: 0, outcomes: ['open'] })
    expect(dealOf(h).retag_through).toBeLessThan(dealOf(h).outcome_seq)

    await pass(h)

    expect((await h.readCall(call.id)).inSearch).toBe(true)
    expect(await h.moments(call.id)).toMatchObject({ returnable: 2, outcomes: ['won'] })
  })

  test('a lost Deal is never returnable even briefly: processing against a Deal that turns lost', async () => {
    const h = await createCallHarness()
    const response = await h.uploadCall(transcriptText('lost', 2), { dealId: 'DEAL-L' })
    const call = callSchema.parse(await response.json())
    const embed = h.deps.embedder.embed.bind(h.deps.embedder)
    h.deps.embedder.embed = async (...args) => {
      await h.setOutcome(dealOf(h).id, 'lost')
      return embed(...args)
    }
    await h.runCalls()
    expect((await h.moments(call.id)).returnable).toBe(0)
    await pass(h)
    expect(await h.moments(call.id)).toMatchObject({ returnable: 0, outcomes: ['lost'] })
  })
})

describe('the re-tag converges when things move under it', () => {
  test('an Outcome that changes while a Call is re-tagged is followed to the newest sequence', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'mid')
    const id = dealOf(h).id
    await h.setOutcome(id, 'won')
    const patch = h.deps.vectors.setAttributes.bind(h.deps.vectors)
    let moved = false
    h.deps.vectors.setAttributes = async (...args) => {
      const missing = await patch(...args)
      if (!moved) {
        moved = true
        await h.setOutcome(id, 'lost')
      }
      return missing
    }

    await pass(h)

    expect(await h.moments(call.id)).toMatchObject({ outcomes: ['lost'], returnable: 0 })
    expect(dealOf(h).retag_through).toBe(dealOf(h).outcome_seq)
    expect(dealOf(h).outcome).toBe('lost')
  })

  test('a Call that finishes mid-re-tag with an older tag brings the Deal back and the next pass converges', async () => {
    const h = await createCallHarness()
    const first = await readyCall(h, 'first')
    const secondResponse = await h.uploadCall(transcriptText('second', 2), { dealId: 'DEAL-1' })
    const second = callSchema.parse(await secondResponse.json())
    const id = dealOf(h).id
    const embed = h.deps.embedder.embed.bind(h.deps.embedder)
    let started = false
    h.deps.embedder.embed = async (...args) => {
      if (!started) {
        started = true
        // The second Call reads its tag (open), then the Deal turns won and the first Call is re-tagged completely.
        const vectors = await embed(...args)
        await h.setOutcome(id, 'won')
        await retagOutcomes(h.deps, h.organizationId, never)
        return vectors
      }
      return embed(...args)
    }

    await h.runCalls()

    // The second Call finished with the tag it had read: the Deal is behind again.
    expect((await h.readCall(second.id)).state).toBe('ready')
    expect(dealOf(h).retag_through).toBeLessThan(dealOf(h).outcome_seq)
    expect((await h.moments(second.id)).returnable).toBe(0)
    h.deps.embedder.embed = embed

    await pass(h)

    expect(dealOf(h).retag_through).toBe(dealOf(h).outcome_seq)
    expect((await h.moments(second.id)).returnable).toBe(2)
    expect((await h.moments(first.id)).returnable).toBe(2)
  })

  test('a Call deleted while it is re-tagged is not recorded as current and is never returnable', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'del')
    await h.setOutcome(dealOf(h).id, 'won')
    const patch = h.deps.vectors.setAttributes.bind(h.deps.vectors)
    h.deps.vectors.setAttributes = async (...args) => {
      const missing = await patch(...args)
      expect((await h.send('DELETE', `/v1/playbook/calls/${call.id}`)).status).toBe(200)
      return missing
    }

    await pass(h)

    expect((await h.moments(call.id)).returnable).toBe(0)
    expect((await h.readCall(call.id)).state).toBe('deleted')
    // The cleanup of the deletion, not the re-tag, removes the vectors.
    await h.deps.time.advance(10 * 60_000)
    await cleanupPendingCalls(h.deps, h.organizationId, never)
    expect((await h.moments(call.id)).total).toBe(0)
  })

  test('one unreadable Call does not hold up the Deals behind it, and is reported without its content', async () => {
    const h = await createCallHarness()
    const bad = await readyCall(h, 'bad', 'DEAL-BAD')
    const good = await readyCall(h, 'good', 'DEAL-GOOD')
    const badKey = h.deps.database.calls(h.organizationId).find((c) => c.id === bad.id)?.object_key
    await h.deps.objects.delete(h.organizationId, String(badKey))
    await h.setOutcome(dealOf(h, 0).id, 'won')
    await h.setOutcome(dealOf(h, 1).id, 'won')

    await pass(h)

    expect((await h.moments(good.id)).returnable).toBe(2)
    expect((await h.moments(bad.id)).returnable).toBe(0)
    expect(logged(h.deps, 'an Outcome re-tag pass ended')[0]).toMatchObject({ skipped: 1 })
  })

  test('Deals that can never finish do not starve the Deals behind them', async () => {
    const h = await createCallHarness()
    for (let i = 0; i < RETAG_DEALS_PER_PASS; i++) {
      const stuck = await readyCall(h, `stuck${i}`, `DEAL-S${i}`)
      const key = h.deps.database.calls(h.organizationId).find((c) => c.id === stuck.id)?.object_key
      await h.deps.objects.delete(h.organizationId, String(key))
    }
    const good = await readyCall(h, 'behind', 'DEAL-Z')
    for (const deal of h.deps.database.deals(h.organizationId)) {
      Object.assign(deal, { outcome: 'won', outcome_seq: 1 })
    }

    await pass(h)

    expect((await h.moments(good.id)).returnable).toBe(2)
  })

  test('a pass takes a bounded number of Deals', async () => {
    const h = await createCallHarness()
    for (let i = 0; i < RETAG_DEALS_PER_PASS + 2; i++) {
      await readyCall(h, `bounded${i}`, `DEAL-${i}`)
    }
    for (const deal of h.deps.database.deals(h.organizationId)) {
      Object.assign(deal, { outcome: 'won', outcome_seq: 1 })
    }

    const first = await retagOutcomes(h.deps, h.organizationId, never)
    const second = await retagOutcomes(h.deps, h.organizationId, never)

    expect(first.deals).toBe(RETAG_DEALS_PER_PASS)
    expect(second.deals).toBe(2)
  })

  test("a second Organization is never touched by this Organization's re-tag", async () => {
    const h = await createCallHarness()
    await readyCall(h, 'mine')
    const other = `org_${'7'.repeat(32)}`
    h.deps.database.seedDeal({
      id: `deal_${'7'.repeat(32)}`,
      organization_id: other,
      deal_id: 'OTHER',
      outcome: 'won',
      outcome_seq: 2,
    })

    await retagOutcomes(h.deps, h.organizationId, never)

    expect(h.deps.database.deals(other)[0]).toMatchObject({ outcome_seq: 2 })
    expect(h.deps.database.deals(other)[0]?.retag_through ?? 0).toBe(0)
    void personIn
  })
})

describe('the re-tag patches tags and never embeds', () => {
  const snapshot = async (h: CallHarness, callId: string, organizationId = h.organizationId) =>
    (
      await h.deps.vectors.search(organizationId, {
        vector: new Array<number>(h.deps.vectors.dimensions).fill(0.1),
        topK: 100,
        filter: { call_id: callId },
      })
    )
      .map((hit) => ({ id: hit.id, score: hit.score }))
      .sort((a, b) => a.id.localeCompare(b.id))

  test('an Outcome flip on a Deal with several Calls costs only setAttributes calls and leaves the vectors unchanged', async () => {
    const h = await createCallHarness()
    const calls = [await readyCall(h, 'x'), await readyCall(h, 'y'), await readyCall(h, 'z')]
    const before = await Promise.all(calls.map((c) => snapshot(h, c.id)))
    const embeds: number[] = []
    const writes: string[] = []
    const embed = h.deps.embedder.embed.bind(h.deps.embedder)
    h.deps.embedder.embed = async (...args) => {
      embeds.push(1)
      return embed(...args)
    }
    const upsert = h.deps.vectors.upsert.bind(h.deps.vectors)
    h.deps.vectors.upsert = async (...args) => {
      writes.push('upsert')
      return upsert(...args)
    }
    const patch = h.deps.vectors.setAttributes.bind(h.deps.vectors)
    h.deps.vectors.setAttributes = async (...args) => {
      writes.push('setAttributes')
      return patch(...args)
    }
    await h.setOutcome(dealOf(h).id, 'won')

    await pass(h)

    expect(embeds).toEqual([])
    expect(writes).toEqual(['setAttributes', 'setAttributes', 'setAttributes'])
    expect(await Promise.all(calls.map((c) => snapshot(h, c.id)))).toEqual(before)
    for (const call of calls) {
      expect(await h.moments(call.id)).toMatchObject({ returnable: 2, outcomes: ['won'] })
    }
  })

  test('a missing vector leaves the Call not current, creates nothing and is logged by ids only', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'gap')
    const row = h.deps.database.calls(h.organizationId).find((c) => c.id === call.id)
    await h.deps.vectors.delete(h.organizationId, [
      momentVectorId(call.id, Number(row?.epoch), Number(row?.rep_seq), 0),
    ])
    await h.setOutcome(dealOf(h).id, 'won')

    await pass(h)

    expect((await h.moments(call.id)).total).toBe(1)
    expect(row?.tagged_outcome_seq).toBeLessThan(dealOf(h).outcome_seq)
    expect(dealOf(h).retag_through ?? 0).toBeLessThan(dealOf(h).outcome_seq)
    expect((await h.readCall(call.id)).inSearch).toBe(false)
    const line = logged(h.deps, 'a Call has Moment vectors missing; its tag stays pending')[0]
    expect(line).toMatchObject({ callId: call.id, missing: 1 })
  })

  test('another Organization with the same Call ids loses nothing and gains nothing', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'mine')
    const other = `org_${'8'.repeat(32)}`
    const row = h.deps.database.calls(h.organizationId).find((c) => c.id === call.id)
    await h.deps.vectors.upsert(other, [
      {
        id: momentVectorId(call.id, Number(row?.epoch), Number(row?.rep_seq), 0),
        vector: new Array<number>(h.deps.vectors.dimensions).fill(0.2),
        attributes: { call_id: call.id, outcome: 'open', outcome_seq: 0 },
      },
    ])
    await h.setOutcome(dealOf(h).id, 'won')

    await pass(h)

    const hits = await h.deps.vectors.search(other, {
      vector: new Array<number>(h.deps.vectors.dimensions).fill(0.2),
      topK: 10,
      filter: { call_id: call.id },
    })
    expect(hits.map((hit) => hit.attributes?.outcome)).toEqual(['open'])
  })
})
