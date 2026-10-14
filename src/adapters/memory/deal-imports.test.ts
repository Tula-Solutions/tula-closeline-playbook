import { describe, expect, test } from 'bun:test'
import {
  DEAL_IMPORT_APPLY,
  DEAL_IMPORT_CLAIM,
  DEAL_IMPORT_ERASE_BATCH,
  DEAL_IMPORT_FAIL,
  DEAL_IMPORT_FINISH,
  DEAL_IMPORT_GET,
  DEAL_IMPORT_GIVE_UP_SPENT,
  DEAL_IMPORT_HEARTBEAT,
  DEAL_IMPORT_INSERT,
  DEAL_IMPORT_LIST,
  DEAL_IMPORT_OBJECT_REMOVED,
  DEAL_IMPORT_PURGE_BATCH,
  DEAL_IMPORT_RETRY,
  DEAL_IMPORT_ROWS_LIST,
  DEAL_IMPORT_ROWS_LIST_BY_RESULT,
  ORGANIZATION_REMOVAL_STATUS,
  ORGANIZATION_REMOVE_REST,
  QUOTA_LOCK,
} from 'tula-closeline-db'
import { createFixedClock } from 'tula-closeline-kit'
import { createMemoryPlaybookDatabase } from './playbook-database'

const ORG = `org_${'a'.repeat(32)}`
const OTHER = `org_${'b'.repeat(32)}`
const USER = `usr_${'1'.repeat(32)}`
const imp = (n: number) => `dimp_${n.toString(16).padStart(32, '0')}`

function setup() {
  const clock = createFixedClock(new Date('2026-01-01T00:00:00Z'))
  const db = createMemoryPlaybookDatabase({ clock })
  return { db, clock }
}

type Sent = {
  row_number: number
  deal_id: string | null
  reason?: string | null
  outcome?: string | null
  closed_at?: string | null
  amount?: string | null
  currency?: string | null
  name?: string | null
}
const sent = (rows: Sent[]) =>
  JSON.stringify(
    rows.map((r) => ({
      reason: null,
      outcome: 'open',
      closed_at: null,
      amount: null,
      currency: null,
      name: null,
      ...r,
    }))
  )

/** Inserts an import and claims it; returns its claim token. */
async function claimed(db: ReturnType<typeof setup>['db'], n = 1, organization = ORG) {
  await db.scope(organization, (run) =>
    run(DEAL_IMPORT_INSERT, [organization, imp(n), USER, `deal-imports/${imp(n)}/original.csv`, 10])
  )
  const claim = await db.scope(organization, (run) =>
    run(DEAL_IMPORT_CLAIM, [organization, 5, 60_000])
  )
  return String(claim.rows.find((r) => r.id === imp(n))?.claim_token)
}

const apply = (
  db: ReturnType<typeof setup>['db'],
  token: string,
  rows: Sent[],
  limit = 1000,
  n = 1,
  organization = ORG,
  lock = true
) =>
  db.scope(organization, async (run) => {
    if (lock) {
      await run(QUOTA_LOCK, [organization])
    }
    const result = await run(DEAL_IMPORT_APPLY, [
      organization,
      imp(n),
      token,
      sent(rows),
      limit,
      500,
    ])
    return {
      summary: result.rows.find((r) => r.kind === 'summary'),
      changed: result.rows.filter((r) => r.kind === 'outcome_changed'),
    }
  })

describe('the apply statement requires the Organization upload lock', () => {
  test('without QUOTA_LOCK in the same transaction it raises the lock error and writes nothing', async () => {
    const { db } = setup()
    const token = await claimed(db)

    const attempt = apply(db, token, [{ row_number: 2, deal_id: 'A' }], 1000, 1, ORG, false)

    await expect(attempt).rejects.toMatchObject({
      code: '55000',
      message: expect.stringContaining('playbook.upload_lock'),
    })
    expect(db.deals(ORG)).toEqual([])
    expect(db.importRows(ORG, imp(1))).toEqual([])
  })

  test('the lock taken in an earlier transaction does not count', async () => {
    const { db } = setup()
    const token = await claimed(db)
    await db.scope(ORG, (run) => run(QUOTA_LOCK, [ORG]))

    await expect(
      apply(db, token, [{ row_number: 2, deal_id: 'A' }], 1000, 1, ORG, false)
    ).rejects.toMatchObject({ code: '55000' })
  })

  test('with the lock the batch is applied', async () => {
    const { db } = setup()
    const token = await claimed(db)

    const result = await apply(db, token, [{ row_number: 2, deal_id: 'A' }])

    expect(result.summary).toMatchObject({ taken: 1 })
    expect(db.deals(ORG)).toHaveLength(1)
  })
})

describe('the import row and its job', () => {
  test('an insert is uploaded with no counts; it is invisible to another Organization', async () => {
    const { db } = setup()
    await claimed(db)

    const mine = await db.scope(ORG, (run) => run(DEAL_IMPORT_GET, [ORG, imp(1)]))
    const theirs = await db.scope(OTHER, (run) => run(DEAL_IMPORT_GET, [OTHER, imp(1)]))

    expect(mine.rows[0]).toMatchObject({
      state: 'processing',
      row_count: null,
      applied_count: null,
    })
    expect(theirs.rows).toEqual([])
  })

  test('the claim fences every later statement on its token', async () => {
    const { db } = setup()
    const token = await claimed(db)
    const wrong = crypto.randomUUID()

    for (const [statement, extra] of [
      [DEAL_IMPORT_HEARTBEAT, [60_000]],
      [DEAL_IMPORT_RETRY, [0]],
      [DEAL_IMPORT_FAIL, ['unreadable']],
      [DEAL_IMPORT_FINISH, [0]],
    ] as const) {
      const result = await db.scope(ORG, (run) => run(statement, [ORG, imp(1), wrong, ...extra]))
      expect(result.rows).toEqual([])
    }
    const ok = await db.scope(ORG, (run) =>
      run(DEAL_IMPORT_HEARTBEAT, [ORG, imp(1), token, 60_000])
    )
    expect(ok.rows).toHaveLength(1)
  })

  test('a retry makes the import claimable again and counts attempts; a spent one is given up', async () => {
    const { db } = setup()
    const token = await claimed(db)
    await db.scope(ORG, (run) => run(DEAL_IMPORT_RETRY, [ORG, imp(1), token, 0]))
    expect(db.imports(ORG)[0]).toMatchObject({ state: 'uploaded', attempts: 1 })

    db.seedImport({ id: imp(2), organization_id: ORG, state: 'processing', attempts: 20 })
    const spent = await db.scope(ORG, (run) => run(DEAL_IMPORT_GIVE_UP_SPENT, [ORG, 10]))

    expect(spent.rows.map((r) => r.id)).toEqual([imp(2)])
    expect(db.imports(ORG).find((i) => i.id === imp(2))).toMatchObject({
      state: 'failed',
      failure_reason: 'processing_failed',
    })
  })

  test('the list pages newest first by the text cursor', async () => {
    const { db } = setup()
    for (const n of [1, 2, 3]) {
      await db.scope(ORG, (run) =>
        run(DEAL_IMPORT_INSERT, [ORG, imp(n), USER, `deal-imports/${imp(n)}/original.csv`, 10])
      )
    }

    const first = await db.scope(ORG, (run) => run(DEAL_IMPORT_LIST, [ORG, 'infinity', '', 2]))
    const last = first.rows.at(-1)
    const second = await db.scope(ORG, (run) =>
      run(DEAL_IMPORT_LIST, [ORG, last?.cursor_at, last?.id, 2])
    )

    expect(first.rows.map((r) => r.id)).toEqual([imp(3), imp(2)])
    expect(second.rows.map((r) => r.id)).toEqual([imp(1)])
  })
})

describe('applying a batch', () => {
  test('creates Deals, reports every row once and moves the counts and report_through together', async () => {
    const { db } = setup()
    const token = await claimed(db)

    const { summary } = await apply(db, token, [
      { row_number: 2, deal_id: 'A', outcome: 'won', amount: '10.5', currency: 'EUR' },
      { row_number: 3, deal_id: 'B', outcome: 'open' },
    ])

    expect(summary).toMatchObject({ taken: 2, applied: 2, rejected: 0, through: 3, refusal: null })
    expect(
      db.deals(ORG).map((d) => [d.deal_id, d.outcome, d.amount, d.appeared_in_import])
    ).toEqual([
      ['A', 'won', '10.50', true],
      ['B', 'open', null, true],
    ])
    expect(db.importRows(ORG, imp(1)).map((r) => r.row_number)).toEqual([2, 3])
  })

  test('a won or lost Deal is outcome_already_decided; an open one takes the row, moves its sequence once and reports the change', async () => {
    const { db } = setup()
    db.seedDeal({
      id: `deal_${'1'.repeat(32)}`,
      organization_id: ORG,
      deal_id: 'WON',
      outcome: 'won',
    })
    db.seedDeal({
      id: `deal_${'2'.repeat(32)}`,
      organization_id: ORG,
      deal_id: 'OPEN',
      amount: '5.00',
    })
    const token = await claimed(db)

    const { summary, changed } = await apply(db, token, [
      { row_number: 2, deal_id: 'WON', outcome: 'won' },
      { row_number: 3, deal_id: 'OPEN', outcome: 'lost', closed_at: '2026-01-01T00:00:00.000Z' },
    ])

    expect(summary).toMatchObject({ applied: 1, rejected: 1 })
    expect(db.importRows(ORG, imp(1))[0]).toMatchObject({
      result: 'rejected',
      reason: 'outcome_already_decided',
    })
    expect(changed).toEqual([
      expect.objectContaining({ deal_record_id: `deal_${'2'.repeat(32)}`, outcome_seq: 1 }),
    ])
    // A blank amount never clears the stored one.
    expect(db.deals(ORG).find((d) => d.deal_id === 'OPEN')).toMatchObject({
      outcome: 'lost',
      amount: '5.00',
      outcome_seq: 1,
    })
  })

  test('an open row for an open Deal with nothing new changes no sequence and reports no change', async () => {
    const { db } = setup()
    db.seedDeal({ id: `deal_${'2'.repeat(32)}`, organization_id: ORG, deal_id: 'OPEN' })
    const token = await claimed(db)

    const { changed } = await apply(db, token, [
      { row_number: 2, deal_id: 'OPEN', outcome: 'open' },
    ])

    expect(changed).toEqual([])
    expect(db.deals(ORG)[0]?.outcome_seq).toBe(0)
  })

  test('the first row of a deal id wins, within a batch and across batches; the repeat is duplicate_in_file whatever else is wrong', async () => {
    const { db } = setup()
    const token = await claimed(db)

    await apply(db, token, [
      { row_number: 2, deal_id: 'A', outcome: 'won' },
      { row_number: 3, deal_id: 'A', outcome: 'lost', reason: 'invalid_amount' },
    ])
    await apply(db, token, [{ row_number: 4, deal_id: 'A', outcome: 'lost' }])

    expect(db.importRows(ORG, imp(1)).map((r) => r.reason)).toEqual([
      null,
      'duplicate_in_file',
      'duplicate_in_file',
    ])
    expect(db.deals(ORG)).toHaveLength(1)
  })

  test('a row the contract rejected is reported with its reason and creates nothing; a missing deal id is reported null', async () => {
    const { db } = setup()
    const token = await claimed(db)

    await apply(db, token, [
      { row_number: 2, deal_id: null, reason: 'invalid_deal_id' },
      { row_number: 3, deal_id: 'B', reason: 'invalid_outcome' },
    ])

    expect(db.importRows(ORG, imp(1)).map((r) => [r.deal_id, r.result, r.reason])).toEqual([
      [null, 'rejected', 'invalid_deal_id'],
      ['B', 'rejected', 'invalid_outcome'],
    ])
    expect(db.deals(ORG)).toEqual([])
  })

  test('stops creating Deals at the limit: the rest are deal_limit_reached, existing Deals still update', async () => {
    const { db } = setup()
    db.seedDeal({ id: `deal_${'2'.repeat(32)}`, organization_id: ORG, deal_id: 'OPEN' })
    const token = await claimed(db)

    const { summary } = await apply(
      db,
      token,
      [
        { row_number: 2, deal_id: 'N1' },
        { row_number: 3, deal_id: 'N2' },
        { row_number: 4, deal_id: 'OPEN', outcome: 'won' },
      ],
      2
    )

    expect(summary).toMatchObject({ applied: 2, rejected: 1 })
    expect(db.importRows(ORG, imp(1)).map((r) => r.reason)).toEqual([
      null,
      'deal_limit_reached',
      null,
    ])
  })

  test('resumes from report_through: rows at or below it change nothing, rows after a gap are not taken', async () => {
    const { db } = setup()
    const token = await claimed(db)
    await apply(db, token, [{ row_number: 2, deal_id: 'A' }])

    const again = await apply(db, token, [
      { row_number: 2, deal_id: 'A' },
      { row_number: 3, deal_id: 'B' },
      { row_number: 5, deal_id: 'D' },
    ])

    expect(again.summary).toMatchObject({ taken: 1, through: 3 })
    expect(db.deals(ORG).map((d) => d.deal_id)).toEqual(['A', 'B'])
    expect(db.importRows(ORG, imp(1))).toHaveLength(2)
  })

  test.each([
    ['a row number below 2', [{ row_number: 1, deal_id: 'A' }], 'row_number_range'],
    ['a row number above 50001', [{ row_number: 50_002, deal_id: 'A' }], 'row_number_range'],
    [
      'a repeated row number',
      [
        { row_number: 2, deal_id: 'A' },
        { row_number: 2, deal_id: 'B' },
      ],
      'row_number_repeated',
    ],
  ])('refuses %s cleanly: nothing taken, nothing recorded', async (_label, rows, refusal) => {
    const { db } = setup()
    const token = await claimed(db)

    const { summary } = await apply(db, token, rows)

    expect(summary).toMatchObject({ taken: 0, refusal })
    expect(db.deals(ORG)).toEqual([])
    expect(db.importRows(ORG, imp(1))).toEqual([])
  })

  test('applies nothing for a wrong token or another Organization', async () => {
    const { db } = setup()
    const token = await claimed(db)

    const wrong = await apply(db, crypto.randomUUID(), [{ row_number: 2, deal_id: 'A' }])
    const stranger = await apply(db, token, [{ row_number: 2, deal_id: 'A' }], 1000, 1, OTHER)

    expect(wrong.summary).toBeUndefined()
    expect(stranger.summary).toBeUndefined()
    expect(db.deals(ORG)).toEqual([])
  })

  test('the finish needs the true row count', async () => {
    const { db } = setup()
    const token = await claimed(db)
    await apply(db, token, [
      { row_number: 2, deal_id: 'A' },
      { row_number: 3, deal_id: 'B' },
    ])

    const low = await db.scope(ORG, (run) => run(DEAL_IMPORT_FINISH, [ORG, imp(1), token, 1]))
    const high = await db.scope(ORG, (run) => run(DEAL_IMPORT_FINISH, [ORG, imp(1), token, 3]))
    const exact = await db.scope(ORG, (run) => run(DEAL_IMPORT_FINISH, [ORG, imp(1), token, 2]))

    expect(low.rows).toEqual([])
    expect(high.rows).toEqual([])
    expect(exact.rows[0]).toMatchObject({ row_count: 2, applied_count: 2, rejected_count: 0 })
    expect(db.imports(ORG)[0]).toMatchObject({ state: 'completed' })
  })

  test('reads the report by row number, and only the rejected rows by result', async () => {
    const { db } = setup()
    const token = await claimed(db)
    await apply(db, token, [
      { row_number: 2, deal_id: 'A' },
      { row_number: 3, deal_id: 'B', reason: 'invalid_amount' },
      { row_number: 4, deal_id: 'C' },
    ])

    const all = await db.scope(ORG, (run) => run(DEAL_IMPORT_ROWS_LIST, [ORG, imp(1), 2, 10]))
    const bad = await db.scope(ORG, (run) =>
      run(DEAL_IMPORT_ROWS_LIST_BY_RESULT, [ORG, imp(1), 0, 10, 'rejected'])
    )

    expect(all.rows.map((r) => r.row_number)).toEqual([3, 4])
    expect(bad.rows.map((r) => r.row_number)).toEqual([3])
    expect(Object.keys(all.rows[0] ?? {}).sort()).toEqual([
      'deal_id',
      'reason',
      'result',
      'row_number',
    ])
  })
})

describe('erasure of imports', () => {
  test('erase, remove the object, purge in steps, and only then can the rest be removed', async () => {
    const { db } = setup()
    const token = await claimed(db)
    await apply(db, token, [
      { row_number: 2, deal_id: 'A' },
      { row_number: 3, deal_id: 'B' },
    ])

    const erased = await db.scope(ORG, (run) => run(DEAL_IMPORT_ERASE_BATCH, [ORG, 10]))
    expect(erased.rows[0]).toMatchObject({ id: imp(1), object_pending: true })
    expect(db.imports(ORG)[0]).toMatchObject({
      state: 'failed',
      failure_reason: 'processing_failed',
    })
    // Fenced: the erased import's job can no longer write.
    expect((await apply(db, token, [{ row_number: 4, deal_id: 'C' }])).summary).toBeUndefined()

    const early = await db.scope(ORG, (run) => run(DEAL_IMPORT_PURGE_BATCH, [ORG, imp(1), 1]))
    expect(early.rows).toEqual([])
    await db.scope(ORG, (run) => run(DEAL_IMPORT_OBJECT_REMOVED, [ORG, imp(1)]))
    const step = await db.scope(ORG, (run) => run(DEAL_IMPORT_PURGE_BATCH, [ORG, imp(1), 1]))
    expect(step.rows[0]).toMatchObject({ deleted_rows: 1, import_deleted: false })
    const last = await db.scope(ORG, (run) => run(DEAL_IMPORT_PURGE_BATCH, [ORG, imp(1), 1]))
    expect(last.rows[0]).toMatchObject({ deleted_rows: 1, import_deleted: true })

    const rest = await db.scope(ORG, (run) =>
      run(ORGANIZATION_REMOVE_REST, [ORG, 'documents.remove_all'])
    )
    expect(rest.rows[0]).toMatchObject({ removed: false }) // the Deals remain
  })

  test('the removal status and the rest wait for imports', async () => {
    const { db } = setup()
    await claimed(db)

    const status = await db.scope(ORG, (run) => run(ORGANIZATION_REMOVAL_STATUS, [ORG]))
    const rest = await db.scope(ORG, (run) => run(ORGANIZATION_REMOVE_REST, [ORG, 'x']))

    expect(status.rows[0]).toMatchObject({ no_imports: false, removed: false })
    expect(rest.rows[0]).toMatchObject({ removed: false })
  })

  test('a different Organization is untouched by an erase', async () => {
    const { db } = setup()
    await claimed(db)
    await claimed(db, 2, OTHER)

    await db.scope(ORG, (run) => run(DEAL_IMPORT_ERASE_BATCH, [ORG, 10]))

    expect(db.imports(OTHER)[0]?.erased_at).toBeNull()
  })

  test('discovery names an Organization with a due import and not one with none', async () => {
    const { db } = setup()
    await db.scope(ORG, (run) =>
      run(DEAL_IMPORT_INSERT, [ORG, imp(1), USER, `deal-imports/${imp(1)}/original.csv`, 10])
    )

    const found = await db.discover('import_apply', '', 10)

    expect(found.map((r) => r.organization_id)).toEqual([ORG])
  })
})
