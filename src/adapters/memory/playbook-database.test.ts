import { describe, expect, test } from 'bun:test'
import {
  DEAL_BY_DEAL_ID,
  DEAL_ERASE_BATCH,
  DEAL_GET,
  DEAL_LIST,
  DEAL_LIST_BY_IMPORT_FLAG,
  DEAL_LIST_BY_OUTCOME,
  DEAL_SET_OUTCOME,
  ORGANIZATION_REMOVAL_STATUS,
  ORGANIZATION_REMOVE_REST,
  RIGHTS_CONFIRM,
  RIGHTS_GET,
} from 'tula-closeline-db'
import { createFixedClock } from 'tula-closeline-kit'
import { createMemoryPlaybookDatabase, MEMORY_DEAL_MAX_SEQ } from './playbook-database'

const ORG = `org_${'a'.repeat(32)}`
const ID = `doc_${'1'.repeat(32)}`

function database() {
  const db = createMemoryPlaybookDatabase({
    clock: createFixedClock(new Date('2026-01-01T00:00:00Z')),
  })
  db.seed({ id: ID, organization_id: ORG })
  return db
}

describe('the database double refuses what the table refuses', () => {
  test.each([
    ['rewriting created_at', { created_at: 1 }],
    ['rewriting the content hash', { content_hash: 'ff' }],
    ['moving epoch down', { epoch: -1 }],
    ['a deleted state with no deletion time', { state: 'deleted' as const }],
    ['a failed state with no reason', { state: 'failed' as const }],
  ])('%s', (_label, change) => {
    expect(() => database().update(ORG, ID, change)).toThrow()
  })

  test('a purge time before the deletion time', () => {
    expect(() =>
      database().update(ORG, ID, { state: 'deleted', deleted_at: 100, purge_due_at: 99 })
    ).toThrow()
  })

  test('a deletion moved back together with its purge time is allowed', () => {
    const db = database()

    db.update(ORG, ID, { state: 'deleted', deleted_at: 100, purge_due_at: 200 })
    db.update(ORG, ID, { deleted_at: 50, purge_due_at: 150 })

    expect(db.documents(ORG)[0]?.purge_due_at).toBe(150)
  })
})

const OTHER = `org_${'b'.repeat(32)}`
const deal = (n: number) => `deal_${n.toString(16).padStart(32, '0')}`
const USER = `usr_${'1'.repeat(32)}`

function withDeals() {
  const db = createMemoryPlaybookDatabase({
    clock: createFixedClock(new Date('2026-01-01T00:00:00Z')),
  })
  // Three Deals created in the same millisecond, 1 and 2 microseconds apart, and one older.
  const base = Date.parse('2026-01-01T00:00:00Z') * 1000
  db.seedDeal({
    id: deal(1),
    organization_id: ORG,
    deal_id: 'A-1',
    created_at_us: base - 5_000_000,
  })
  db.seedDeal({ id: deal(2), organization_id: ORG, deal_id: 'A-2', created_at_us: base })
  db.seedDeal({
    id: deal(3),
    organization_id: ORG,
    deal_id: 'A-3',
    created_at_us: base + 1,
    outcome: 'won',
    appeared_in_import: true,
  })
  db.seedDeal({ id: deal(4), organization_id: ORG, deal_id: 'A-4', created_at_us: base + 2 })
  db.seedDeal({ id: deal(9), organization_id: OTHER, deal_id: 'A-1' })
  return db
}

describe('the database double reads Deals as the statements do', () => {
  test('a malformed list cursor is SQLSTATE 22007', async () => {
    const db = withDeals()
    await expect(
      db.scope(ORG, (run) => run(DEAL_LIST, [ORG, 'yesterday', '', 10]))
    ).rejects.toMatchObject({ code: '22007' })
  })

  test('the list is newest first and its text cursor keeps rows that share a millisecond', async () => {
    const db = withDeals()
    const first = await db.scope(ORG, (run) => run(DEAL_LIST, [ORG, 'infinity', '', 2]))
    expect(first.rows.map((r) => r.id)).toEqual([deal(4), deal(3)])
    const last = first.rows[1] as { cursor_at: string; id: string }
    expect(last.cursor_at).toMatch(/^2026-01-01 00:00:00\.000001\+00$/)

    const second = await db.scope(ORG, (run) => run(DEAL_LIST, [ORG, last.cursor_at, last.id, 10]))
    expect(second.rows.map((r) => r.id)).toEqual([deal(2), deal(1)])
  })

  test('the outcome and import-flag lists filter, and the other Organization sees nothing of these Deals', async () => {
    const db = withDeals()
    const won = await db.scope(ORG, (run) =>
      run(DEAL_LIST_BY_OUTCOME, [ORG, 'infinity', '', 10, 'won'])
    )
    const imported = await db.scope(ORG, (run) =>
      run(DEAL_LIST_BY_IMPORT_FLAG, [ORG, 'infinity', '', 10, true])
    )
    const theirs = await db.scope(OTHER, (run) => run(DEAL_LIST, [OTHER, 'infinity', '', 10]))
    const crossed = await db.scope(OTHER, (run) => run(DEAL_GET, [ORG, deal(1)]))

    expect(won.rows.map((r) => r.id)).toEqual([deal(3)])
    expect(imported.rows.map((r) => r.id)).toEqual([deal(3)])
    expect(theirs.rows.map((r) => r.id)).toEqual([deal(9)])
    expect(crossed.rows).toEqual([])
  })

  test('a lookup is exact and case-sensitive, within the Organization', async () => {
    const db = withDeals()
    const found = await db.scope(ORG, (run) => run(DEAL_BY_DEAL_ID, [ORG, 'A-1']))
    const folded = await db.scope(ORG, (run) => run(DEAL_BY_DEAL_ID, [ORG, 'a-1']))
    expect(found.rows.map((r) => r.id)).toEqual([deal(1)])
    expect(folded.rows).toEqual([])
  })
})

describe('the database double sets an Outcome as DEAL_SET_OUTCOME does', () => {
  test('a change moves the sequence by one, a repeat changes nothing, and a missing Deal answers no row', async () => {
    const db = withDeals()
    const set = (id: string, outcome: string, closed: string | null = null, setClosed = false) =>
      db.scope(ORG, (run) => run(DEAL_SET_OUTCOME, [ORG, id, outcome, closed, setClosed]))

    const changed = await set(deal(1), 'won')
    const repeated = await set(deal(1), 'won')
    const missing = await set(deal(77), 'won')

    expect(changed.rows[0]).toMatchObject({ outcome: 'won', outcome_seq: 1, changed: true })
    expect(repeated.rows[0]).toMatchObject({ outcome: 'won', outcome_seq: 1, changed: false })
    expect(missing.rows).toEqual([])
  })

  test('the closing time moves the sequence only when asked and when it differs; null clears it', async () => {
    const db = withDeals()
    const set = (closed: string | null, setClosed: boolean) =>
      db.scope(ORG, (run) => run(DEAL_SET_OUTCOME, [ORG, deal(1), 'open', closed, setClosed]))

    const ignored = await set('2026-02-01', false)
    const dated = await set('2026-02-01', true)
    const same = await set('2026-02-01', true)
    const cleared = await set(null, true)

    expect(ignored.rows[0]).toMatchObject({ changed: false, closed_at: null })
    expect(dated.rows[0]).toMatchObject({ changed: true, outcome_seq: 1 })
    expect(same.rows[0]).toMatchObject({ changed: false, outcome_seq: 1 })
    expect(cleared.rows[0]).toMatchObject({ changed: true, outcome_seq: 2, closed_at: null })
  })

  test('a Deal at the sequence ceiling cannot take another change', async () => {
    const db = withDeals()
    db.seedDeal({
      id: deal(5),
      organization_id: ORG,
      deal_id: 'TOP',
      outcome_seq: MEMORY_DEAL_MAX_SEQ,
    })

    await expect(
      db.scope(ORG, (run) => run(DEAL_SET_OUTCOME, [ORG, deal(5), 'won', null, false]))
    ).rejects.toMatchObject({ code: '23514' })
  })

  test('another Organization cannot change the Deal', async () => {
    const db = withDeals()
    const result = await db.scope(OTHER, (run) =>
      run(DEAL_SET_OUTCOME, [ORG, deal(1), 'won', null, false])
    )
    expect(result.rows).toEqual([])
    expect(db.deals(ORG)[0]?.outcome).toBe('open')
  })
})

describe('the database double keeps the rights confirmation as RIGHTS_CONFIRM does', () => {
  test('the first records, the same version keeps the first, a lower is ignored and a higher replaces', async () => {
    const db = withDeals()
    const confirm = (by: string, version: number) =>
      db.scope(ORG, (run) => run(RIGHTS_CONFIRM, [ORG, by, version]))
    const second = `usr_${'2'.repeat(32)}`

    const first = await confirm(USER, 2)
    const same = await confirm(second, 2)
    const lower = await confirm(second, 1)
    const higher = await confirm(second, 3)

    expect(first.rows[0]).toMatchObject({ confirmed_by: USER, wording_version: 2, recorded: true })
    expect(same.rows[0]).toMatchObject({ confirmed_by: USER, wording_version: 2, recorded: false })
    expect(lower.rows[0]).toMatchObject({ confirmed_by: USER, wording_version: 2, recorded: false })
    expect(higher.rows[0]).toMatchObject({
      confirmed_by: second,
      wording_version: 3,
      recorded: true,
    })
  })

  test('another Organization has its own confirmation', async () => {
    const db = withDeals()
    await db.scope(ORG, (run) => run(RIGHTS_CONFIRM, [ORG, USER, 1]))

    const theirs = await db.scope(OTHER, (run) => run(RIGHTS_GET, [OTHER]))

    expect(theirs.rows).toEqual([])
  })
})

describe('the database double erases Deals before the Organization can be removed', () => {
  test('the rest is refused while a Deal remains, and the status says so', async () => {
    const db = withDeals()
    const refused = await db.scope(ORG, (run) =>
      run(ORGANIZATION_REMOVE_REST, [ORG, 'documents.remove_all'])
    )
    const status = await db.scope(ORG, (run) => run(ORGANIZATION_REMOVAL_STATUS, [ORG]))

    expect(refused.rows[0]).toMatchObject({ removed: false })
    expect(status.rows[0]).toMatchObject({ no_deals: false, removed: false })
  })

  test('batches of Deals are bounded, then the rest removes the rights confirmation too', async () => {
    const db = withDeals()
    await db.scope(ORG, (run) => run(RIGHTS_CONFIRM, [ORG, USER, 1]))
    db.purgeAll(ORG)
    const one = await db.scope(ORG, (run) => run(DEAL_ERASE_BATCH, [ORG, 3]))
    const rest = await db.scope(ORG, (run) => run(DEAL_ERASE_BATCH, [ORG, 3]))
    const removed = await db.scope(ORG, (run) =>
      run(ORGANIZATION_REMOVE_REST, [ORG, 'documents.remove_all'])
    )
    const status = await db.scope(ORG, (run) => run(ORGANIZATION_REMOVAL_STATUS, [ORG]))

    expect(one.rows[0]).toEqual({ deleted: 3 })
    expect(rest.rows[0]).toEqual({ deleted: 1 })
    expect(removed.rows[0]).toMatchObject({ removed: true })
    expect(status.rows[0]).toMatchObject({ no_rights: true, removed: true })
    expect(db.deals(OTHER)).toHaveLength(1)
  })
})
