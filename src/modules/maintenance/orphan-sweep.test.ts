import { describe, expect, test } from 'bun:test'
import { ORPHAN_SWEEP_CLAIM, ORPHAN_SWEEP_PAGE_DONE, ORPHAN_SWEEP_STATE } from 'tula-closeline-db'
import { createPipelineHarness, paragraphs } from '~/modules/ingestion/test-support'
import { visitOrphanSweep } from './housekeeping'

const HOUR = 60 * 60 * 1000
const never = new AbortController().signal

/** Puts `count` old orphan document files in an Organization and returns their keys. */
async function seedOrphans(
  h: ReturnType<typeof createPipelineHarness>,
  organizationId: string,
  count: number
): Promise<string[]> {
  const keys: string[] = []
  for (let i = 0; i < count; i++) {
    const key = `documents/doc_${i.toString(16).padStart(32, '0')}/original.pdf`
    await h.deps.objects.put(organizationId, key, new Uint8Array([1]))
    keys.push(key)
  }
  return keys
}

/** Runs a statement in an Organization's scope. */
function runIn(
  h: ReturnType<typeof createPipelineHarness>,
  organizationId: string,
  text: string,
  params: unknown[]
) {
  return h.deps.scope(organizationId, (run) => run(text, params))
}

describe('the resumable orphan sweep', () => {
  test('a sweep cut short by the page bound resumes from the saved cursor and ends done', async () => {
    const h = createPipelineHarness({ env: { ORPHAN_PAGE_SIZE: '2', ORPHAN_MAX_PAGES: '2' } })
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    const keys = await seedOrphans(h, h.organizationId, 7)
    await h.deps.time.advance(26 * HOUR)

    const first = await visitOrphanSweep(h.deps, h.organizationId, never)

    // Two pages of two: four deleted, and the position is saved.
    expect(first).toEqual({ status: 'incomplete', deleted: 4 })
    const saved = (await runIn(h, h.organizationId, ORPHAN_SWEEP_STATE, [h.organizationId])).rows[0]
    expect(typeof saved?.sweep_cursor).toBe('string')
    expect(saved?.sweep_claim_until).toBeNull()

    const seen: string[] = []
    const second = await visitOrphanSweep(h.deps, h.organizationId, never)
    seen.push(second.status)
    const third = await visitOrphanSweep(h.deps, h.organizationId, never)

    // The next visits carry on from the cursor; nothing is listed from the top again.
    expect([second.status, third.status]).toContain('done')
    const left = (await h.deps.objects.list(h.organizationId, { prefix: 'documents/' })).items
    for (const key of keys) {
      expect(left.map((i) => i.key)).not.toContain(key)
    }
    const state = (await runIn(h, h.organizationId, ORPHAN_SWEEP_STATE, [h.organizationId])).rows[0]
    expect(state?.sweep_cursor ?? null).toBeNull()
  })

  test('the first visit start time is passed on every page of one sweep', async () => {
    const h = createPipelineHarness({ env: { ORPHAN_PAGE_SIZE: '2', ORPHAN_MAX_PAGES: '1' } })
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    await seedOrphans(h, h.organizationId, 6)
    await h.deps.time.advance(26 * HOUR)
    const started = h.deps.clock.now().toISOString()
    const seen: unknown[] = []
    const scope = h.deps.scope
    h.deps.scope = (organizationId, fn) =>
      scope(organizationId, (run) =>
        fn(async (text, params) => {
          if (text === ORPHAN_SWEEP_PAGE_DONE) {
            seen.push(params[1])
          }
          return run(text, params)
        })
      )

    await visitOrphanSweep(h.deps, h.organizationId, never)
    await h.deps.time.advance(60_000)
    await visitOrphanSweep(h.deps, h.organizationId, never)

    expect(seen).toEqual([started, started])
  })

  test('a sweep older than 25 hours begins again from the top', async () => {
    const h = createPipelineHarness({ env: { ORPHAN_PAGE_SIZE: '2', ORPHAN_MAX_PAGES: '1' } })
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    await seedOrphans(h, h.organizationId, 6)
    await h.deps.time.advance(26 * HOUR)
    await visitOrphanSweep(h.deps, h.organizationId, never)
    await h.deps.time.advance(26 * HOUR)
    const restarted = h.deps.clock.now().toISOString()
    const seen: unknown[] = []
    const scope = h.deps.scope
    h.deps.scope = (organizationId, fn) =>
      scope(organizationId, (run) =>
        fn(async (text, params) => {
          if (text === ORPHAN_SWEEP_PAGE_DONE) {
            seen.push(params[1])
          }
          return run(text, params)
        })
      )

    await visitOrphanSweep(h.deps, h.organizationId, never)

    expect(seen).toEqual([restarted])
  })

  test('a second instance cannot claim while a claim is held, and the visit stops', async () => {
    const h = createPipelineHarness()
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    await h.deps.time.advance(26 * HOUR)
    const claim = await runIn(h, h.organizationId, ORPHAN_SWEEP_CLAIM, [h.organizationId, 60_000])
    expect(claim.rows[0]?.claimed).toBe(true)

    const visit = await visitOrphanSweep(h.deps, h.organizationId, never)

    expect(visit).toEqual({ status: 'held_elsewhere', deleted: 0 })
    // Past the deadline the claim is free again.
    await h.deps.time.advance(61_000)
    expect((await visitOrphanSweep(h.deps, h.organizationId, never)).status).toBe('done')
  })

  test('a page done with a stale token has no effect', async () => {
    const h = createPipelineHarness()
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    await h.deps.time.advance(26 * HOUR)
    const claim = await runIn(h, h.organizationId, ORPHAN_SWEEP_CLAIM, [h.organizationId, 1_000])
    const token = claim.rows[0]?.claim_token
    await h.deps.time.advance(5_000)
    await runIn(h, h.organizationId, ORPHAN_SWEEP_CLAIM, [h.organizationId, 60_000])

    const late = await runIn(h, h.organizationId, ORPHAN_SWEEP_PAGE_DONE, [
      h.organizationId,
      h.deps.clock.now().toISOString(),
      null,
      token,
    ])

    expect(late.rows[0]?.held).toBe(false)
    const state = (await runIn(h, h.organizationId, ORPHAN_SWEEP_STATE, [h.organizationId])).rows[0]
    expect(state?.sweep_claim_until).not.toBeNull()
  })

  test('a visit whose claim ran out stops without recording the page', async () => {
    const h = createPipelineHarness({ env: { ORPHAN_CLAIM_MS: '1000' } })
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    await seedOrphans(h, h.organizationId, 1)
    await h.deps.time.advance(26 * HOUR)
    const list = h.deps.objects.list.bind(h.deps.objects)
    h.deps.objects.list = async (org, options) => {
      await h.deps.time.advance(5_000)
      return list(org, options)
    }

    const visit = await visitOrphanSweep(h.deps, h.organizationId, never)

    expect(visit.status).toBe('held_elsewhere')
  })

  test('a second Organization is untouched', async () => {
    const h = createPipelineHarness({ env: { ORPHAN_PAGE_SIZE: '2', ORPHAN_MAX_PAGES: '1' } })
    await h.upload('a.txt', paragraphs(2), { key: 'first' })
    await seedOrphans(h, h.organizationId, 4)
    const other = h.other().organizationId
    const theirs = await seedOrphans(h, other, 4)
    await h.deps.time.advance(26 * HOUR)

    await visitOrphanSweep(h.deps, h.organizationId, never)

    expect((await h.deps.objects.list(other, { prefix: 'documents/' })).items).toHaveLength(
      theirs.length
    )
    const state = await runIn(h, other, ORPHAN_SWEEP_STATE, [other])
    expect(state.rows).toHaveLength(0)
  })
})
