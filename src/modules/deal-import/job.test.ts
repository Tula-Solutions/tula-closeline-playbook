import { describe, expect, test } from 'bun:test'
import {
  dealImportSchema,
  MAX_DEAL_IMPORT_ROWS,
  organizationIdSchema,
} from 'tula-closeline-contract'
import {
  DEAL_IMPORT_APPLY,
  DEAL_IMPORT_CLAIM,
  DEAL_IMPORT_HEARTBEAT,
  QUOTA_LOCK,
} from 'tula-closeline-db'
import { newKey, personIn } from '~/modules/document/test-support'
import { ShuttingDown } from '~/modules/ingestion/runtime'
import { newOrganizationId } from '~/testing'
import { claimedImports, parseImportFile, runImport } from './job'
import { createImportHarness, csv, HEADER, IMPORTS } from './test-support'

const SECRET_ID = 'ACME-SECRET-DEAL-7731'
const SECRET_NAME = 'Secret Customer Name Ltd'
const SECRET_AMOUNT = '987654.32'
const deal = (n: number) => `deal_${n.toString(16).padStart(32, '0')}`

type Harness = Awaited<ReturnType<typeof createImportHarness>>

/** Uploads a CSV and returns the import's id. */
async function upload(h: Harness, text: string | Uint8Array, key?: string): Promise<string> {
  const response = await h.uploadCsv(text, key === undefined ? {} : { key })
  expect(response.status).toBe(202)
  return dealImportSchema.parse(await response.json()).id
}

async function read(h: Harness, importId: string) {
  return dealImportSchema.parse(await (await h.send('GET', `${IMPORTS}/${importId}`)).json())
}

const dealsOf = (h: Harness) => h.deps.database.deals(h.organizationId)

describe('a file the job cannot read fails the import and applies nothing', () => {
  const unreadable: [label: string, make: () => string | Uint8Array][] = [
    [
      'text that is not UTF-8',
      () => new Uint8Array([...new TextEncoder().encode(`${HEADER}\nA,won,,,,`), 0xff, 0xfe, 0x0a]),
    ],
    ['a stray quote inside a cell', () => csv(['A,won,,,,Bad"Name'])],
    ['a quote that never closes', () => csv(['A,won,,,,"open'])],
    ['a cell over 1000 characters', () => csv([`A,won,,,,${'x'.repeat(1001)}`])],
  ]
  test.each(unreadable)('%s is failed with reason unreadable', async (_label, make) => {
    const h = await createImportHarness()
    const id = await upload(h, make())

    await h.runImports()

    expect(await read(h, id)).toMatchObject({ state: 'failed', failureReason: 'unreadable' })
    expect(dealsOf(h)).toEqual([])
    expect(await h.objectKeys()).toEqual([])
  })

  test('a header the early check could only defer on, and that is wrong, is failed unreadable by the job', async () => {
    const h = await createImportHarness()
    const wide = `"${' '.repeat(990)}",`.repeat(10)
    const id = await upload(h, `deal_id,outcome,closed_at,amount,currency,${wide}x\nA,won,,,,\n`)

    await h.runImports()

    expect(await read(h, id)).toMatchObject({ state: 'failed', failureReason: 'unreadable' })
    expect(dealsOf(h)).toEqual([])
  })

  test('more rows than the limit is too_many_rows and nothing is applied', async () => {
    const h = await createImportHarness()
    const rows = Array.from({ length: MAX_DEAL_IMPORT_ROWS + 1 }, (_, i) => `D${i},open,,,,`)
    const id = await upload(h, csv(rows))

    await h.runImports()

    expect(await read(h, id)).toMatchObject({ state: 'failed', failureReason: 'too_many_rows' })
    expect(dealsOf(h)).toEqual([])
    expect(await h.objectKeys()).toEqual([])
  })

  test('exactly the limit is accepted by the parse, and one more row is too many', () => {
    // The job applies the file in batches of 500 rows; running 50,000 rows through the database
    // double clones its state for each batch (about 7 s), so the limit is pinned at the parse, which
    // is where the job decides it. The whole job over 50,000 rows runs in bench/deal-import.bench.test.ts.
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `D${i},open,,,,`)
    const encode = (text: string) => new TextEncoder().encode(text)

    expect(parseImportFile(encode(csv(rows(MAX_DEAL_IMPORT_ROWS)))).records).toHaveLength(
      MAX_DEAL_IMPORT_ROWS
    )
    expect(() => parseImportFile(encode(csv(rows(MAX_DEAL_IMPORT_ROWS + 1))))).toThrow(
      'the Deal import failed: too_many_rows'
    )
  })

  test('a row without a stored file is processing_failed', async () => {
    const h = await createImportHarness()
    const id = await upload(h, csv(['A,won,,,,']))
    for (const key of await h.objectKeys()) {
      await h.deps.objects.delete(h.organizationId, key)
    }

    await h.runImports()
    // Not a file problem the contract names: retried until the attempt bound, then failed.
    for (let i = 0; i < 12; i++) {
      await h.deps.time.advance(700_000)
      await h.runImports()
    }

    expect(await read(h, id)).toMatchObject({ state: 'failed', failureReason: 'processing_failed' })
  })
})

describe('applying a file', () => {
  test('creates Deals, reports every row and removes the CSV', async () => {
    const h = await createImportHarness()
    const id = await upload(
      h,
      csv([
        'A-1,won,2026-01-05,100.5,eur,Alpha',
        'A-2,lost,,,,',
        'A-3,open,,,,',
        'A-4,sideways,,,,',
      ])
    )

    await h.runImports()

    expect(await read(h, id)).toMatchObject({
      state: 'completed',
      rowCount: 4,
      appliedCount: 3,
      rejectedCount: 1,
    })
    expect(dealsOf(h).map((d) => [d.deal_id, d.outcome, d.amount, d.currency, d.name])).toEqual([
      ['A-1', 'won', '100.50', 'EUR', 'Alpha'],
      ['A-2', 'lost', null, null, null],
      ['A-3', 'open', null, null, null],
    ])
    expect(await h.report(id)).toEqual([
      { rowNumber: 2, reason: null, dealId: 'A-1' },
      { rowNumber: 3, reason: null, dealId: 'A-2' },
      { rowNumber: 4, reason: null, dealId: 'A-3' },
      { rowNumber: 5, reason: 'invalid_outcome', dealId: 'A-4' },
    ])
    expect(await h.report(id, 'rejected')).toHaveLength(1)
    expect(await h.objectKeys()).toEqual([])
    expect(h.published).toEqual([])
  })

  test('works without the optional name column, with a BOM and CRLF line ends', async () => {
    const h = await createImportHarness()
    const text = `﻿deal_id,outcome,closed_at,amount,currency\r\nA,won,,,\r\nB,lost,,,\r\n`
    const id = await upload(h, text)

    await h.runImports()

    expect(await read(h, id)).toMatchObject({ state: 'completed', rowCount: 2, appliedCount: 2 })
  })

  test('row numbers are record numbers: a quoted cell spanning lines is one record, a blank line in the middle is reported, trailing blanks are not rows', async () => {
    const h = await createImportHarness()
    const id = await upload(h, `${HEADER}\nA,won,,,,"two\nlines, and a comma"\n\nB,lost,,,,\n\n\n`)

    await h.runImports()

    expect(await read(h, id)).toMatchObject({
      state: 'completed',
      rowCount: 3,
      appliedCount: 1,
      rejectedCount: 2,
    })
    expect(await h.report(id)).toEqual([
      // A name may not hold a line break, so the row is rejected, but it is still one record.
      { rowNumber: 2, reason: 'invalid_name', dealId: 'A' },
      { rowNumber: 3, reason: 'blank_row', dealId: null },
      { rowNumber: 4, reason: null, dealId: 'B' },
    ])
  })

  test('with CRLF, an interior blank line is a blank_row and the trailing newlines are not rows', async () => {
    const h = await createImportHarness()
    const id = await upload(h, `${HEADER}\r\nA,won,,,,\r\n\r\nB,lost,,,,\r\n\r\n\r\n`)

    await h.runImports()

    expect(await read(h, id)).toMatchObject({
      state: 'completed',
      rowCount: 3,
      appliedCount: 2,
      rejectedCount: 1,
    })
    expect(await h.report(id)).toEqual([
      { rowNumber: 2, reason: null, dealId: 'A' },
      { rowNumber: 3, reason: 'blank_row', dealId: null },
      { rowNumber: 4, reason: null, dealId: 'B' },
    ])
  })

  test('closed_at takes a plain date only: a time or an offset is invalid_closed_at', async () => {
    const h = await createImportHarness()
    const id = await upload(
      h,
      csv([
        'A,won,2026-01-31,,,',
        'B,won,2026-01-31T10:00:00,,,',
        'C,won,2026-01-31T10:00:00Z,,,',
        'D,won,2026-01-31+02:00,,,',
      ])
    )

    await h.runImports()

    expect((await h.report(id)).map((r) => r.reason)).toEqual([
      null,
      'invalid_closed_at',
      'invalid_closed_at',
      'invalid_closed_at',
    ])
    expect(h.deps.database.deals(h.organizationId)[0]?.closed_at).toBe('2026-01-31')
  })

  test('an empty data section completes with zero rows', async () => {
    const h = await createImportHarness()
    const id = await upload(h, `${HEADER}\n`)

    await h.runImports()

    expect(await read(h, id)).toMatchObject({ state: 'completed', rowCount: 0, appliedCount: 0 })
  })

  test('the first row of a deal id wins; the repeat is duplicate_in_file whatever else is wrong with it', async () => {
    const h = await createImportHarness()
    const id = await upload(h, csv(['A,won,,,,', 'A,lost,,,,', 'A,nonsense,,,,']))

    await h.runImports()

    expect((await h.report(id)).map((r) => r.reason)).toEqual([
      null,
      'duplicate_in_file',
      'duplicate_in_file',
    ])
    expect(dealsOf(h).map((d) => d.outcome)).toEqual(['won'])
  })

  test('a later CSV may fill the Outcome of an open Deal but never overwrite a decided one', async () => {
    const h = await createImportHarness()
    const first = await upload(h, csv(['A,open,,,,', 'B,won,,,,']))
    await h.runImports()
    const second = await upload(h, csv(['A,won,2026-02-01,,,', 'B,lost,,,,']))

    await h.runImports()

    expect((await h.report(second)).map((r) => r.reason)).toEqual([null, 'outcome_already_decided'])
    expect(dealsOf(h).map((d) => [d.deal_id, d.outcome])).toEqual([
      ['A', 'won'],
      ['B', 'won'],
    ])
    expect(await read(h, first)).toMatchObject({ state: 'completed' })
  })

  test('an Outcome change publishes the same message as the portal route, after the commit, once per Deal', async () => {
    const h = await createImportHarness()
    h.deps.database.seedDeal({ id: deal(1), organization_id: h.organizationId, deal_id: 'A' })
    h.deps.database.seedDeal({ id: deal(2), organization_id: h.organizationId, deal_id: 'B' })
    await upload(h, csv(['A,won,,,,', 'B,open,,,,', 'C,won,,,,']))

    await h.runImports()

    expect(JSON.parse(JSON.stringify(h.published.map((m) => [m.type, m.payload])))).toEqual([
      ['playbook.deal_outcome_changed', { dealRecordId: deal(1), outcomeSeq: 1 }],
    ])
  })

  test('a failed publish does not undo the import and logs ids only', async () => {
    const h = await createImportHarness()
    h.deps.database.seedDeal({ id: deal(1), organization_id: h.organizationId, deal_id: SECRET_ID })
    h.deps.queue.publish = async () => {
      throw new Error('the queue is down')
    }
    const id = await upload(h, csv([`${SECRET_ID},won,,,,`]))

    await h.runImports()

    expect(await read(h, id)).toMatchObject({ state: 'completed', appliedCount: 1 })
    expect(h.deps.logLines.join('\n')).toContain('re-tag job recovers from outcome_seq')
    expect(h.deps.logLines.join('\n')).not.toContain(SECRET_ID)
  })

  test('stops creating Deals at the limit and reports the rest as deal_limit_reached', async () => {
    const h = await createImportHarness({ env: { MAX_DEALS_PER_ORGANIZATION: '2' } })
    const id = await upload(h, csv(['A,open,,,,', 'B,open,,,,', 'C,open,,,,', 'D,open,,,,']))

    await h.runImports()

    expect((await h.report(id)).map((r) => r.reason)).toEqual([
      null,
      null,
      'deal_limit_reached',
      'deal_limit_reached',
    ])
    expect(dealsOf(h)).toHaveLength(2)
    expect(await read(h, id)).toMatchObject({
      state: 'completed',
      appliedCount: 2,
      rejectedCount: 2,
    })
  })

  test('applies in batches of at most 500 rows, renewing the lease before each', async () => {
    const h = await createImportHarness()
    const rows = Array.from({ length: 1201 }, (_, i) => `D${i},open,,,,`)
    const id = await upload(h, csv(rows))
    const before = h.deps.database.statements.length

    await h.runImports()

    const ran = h.deps.database.statements.slice(before)
    expect(ran.filter((s) => s === DEAL_IMPORT_APPLY)).toHaveLength(3)
    expect(ran.filter((s) => s === DEAL_IMPORT_HEARTBEAT).length).toBeGreaterThanOrEqual(3)
    expect(await read(h, id)).toMatchObject({ state: 'completed', rowCount: 1201 })
    expect(dealsOf(h)).toHaveLength(1201)
  })

  test('the apply transaction takes the Organization upload lock first', async () => {
    const h = await createImportHarness()
    await upload(h, csv(['A,open,,,,']))

    await h.runImports()

    const apply = h.deps.database.transactionStatements.find((t) => t.includes(DEAL_IMPORT_APPLY))
    const lock = apply?.findIndex((s) => s.includes('pg_advisory_xact_lock')) ?? -1
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(lock).toBeLessThan(apply?.indexOf(DEAL_IMPORT_APPLY) ?? -1)
  })
})

describe('crashes, redelivery and lost leases', () => {
  test('a failure between batches resumes from report_through without applying a row twice', async () => {
    const h = await createImportHarness()
    const rows = Array.from({ length: 1100 }, (_, i) => `D${i},open,,,,`)
    const id = await upload(h, csv(rows))
    // The first batch applies; the second fails once, as a dropped connection would.
    const base = h.deps.scope
    let applies = 0
    h.deps.scope = (organizationId, work) =>
      base(organizationId, (run) =>
        work(async (text, params) => {
          if (text === DEAL_IMPORT_APPLY && ++applies === 2) {
            throw new Error('connection lost')
          }
          return run(text, params)
        })
      )

    await h.runImports()

    const stopped = h.deps.database.imports(h.organizationId)[0]
    expect(stopped).toMatchObject({ state: 'uploaded', attempts: 1, report_through: 501 })
    await h.deps.time.advance(700_000)
    await h.runImports()

    expect(await read(h, id)).toMatchObject({
      state: 'completed',
      rowCount: 1100,
      appliedCount: 1100,
    })
    expect(dealsOf(h)).toHaveLength(1100)
    expect(new Set(dealsOf(h).map((d) => d.deal_id)).size).toBe(1100)
    const numbers = (await h.report(id)).map((r) => r.rowNumber)
    expect(numbers).toEqual(Array.from({ length: 1100 }, (_, i) => i + 2))
    expect(h.deps.database.imports(h.organizationId)[0]?.attempts).toBe(2)
  })

  test('a job that did not take the upload lock first writes nothing', async () => {
    const h = await createImportHarness()
    await upload(h, csv(['A,won,,,,']))
    const base = h.deps.scope
    h.deps.scope = (organizationId, work) =>
      base(organizationId, (run) =>
        work(async (text, params) =>
          text === QUOTA_LOCK ? { rows: [], rowCount: 0 } : run(text, params)
        )
      )

    await h.runImports()

    expect(dealsOf(h)).toEqual([])
    expect(h.deps.database.imports(h.organizationId)[0]).toMatchObject({ state: 'uploaded' })
  })

  test('a batch sent again after a lost answer changes nothing', async () => {
    const h = await createImportHarness()
    const id = await upload(h, csv(['A,won,,,,', 'B,lost,,,,']))
    await h.runImports()

    // A second claim cannot happen on a completed import; the statement is what guards a late repeat.
    expect(h.deps.database.imports(h.organizationId)[0]).toMatchObject({ id, state: 'completed' })
    expect(dealsOf(h)).toHaveLength(2)
    await h.runImports()
    expect(dealsOf(h)).toHaveLength(2)
  })

  test('a lease that passed to another claim stops the run: nothing more is written and nothing is failed', async () => {
    const h = await createImportHarness()
    const id = await upload(h, csv(['A,open,,,,']))
    const base = h.deps.objects.get.bind(h.deps.objects)
    h.deps.objects.get = async (...args) => {
      const stored = await base(...args)
      // Another instance claims the import while this one reads the file.
      const row = h.deps.database.imports(h.organizationId)[0]
      if (row !== undefined) {
        row.claim_token = crypto.randomUUID()
      }
      return stored
    }

    await h.runImports()

    expect(dealsOf(h)).toEqual([])
    expect(h.deps.database.imports(h.organizationId)[0]).toMatchObject({ id, state: 'processing' })
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test('an import erased while it runs stops without writing', async () => {
    const h = await createImportHarness()
    await upload(h, csv(['A,open,,,,']))
    const base = h.deps.objects.get.bind(h.deps.objects)
    h.deps.objects.get = async (...args) => {
      const stored = await base(...args)
      const row = h.deps.database.imports(h.organizationId)[0]
      if (row !== undefined) {
        row.erased_at = Date.now()
      }
      return stored
    }

    await h.runImports()

    expect(dealsOf(h)).toEqual([])
  })

  test('shutdown gives the import back, due at once', async () => {
    const h = await createImportHarness()
    const id = await upload(h, csv(['A,open,,,,']))
    const claimed = await h.deps.database.scope(h.organizationId, (run) =>
      run(DEAL_IMPORT_CLAIM, [h.organizationId, 1, 60_000])
    )
    const [claim] = claimedImports(claimed.rows)

    const outcome = await runImport(
      h.deps,
      h.organizationId,
      claim as NonNullable<typeof claim>,
      AbortSignal.abort(new ShuttingDown())
    )

    expect(outcome).toBe('released')
    expect(h.deps.database.imports(h.organizationId)[0]).toMatchObject({ id, state: 'uploaded' })
    expect(dealsOf(h)).toEqual([])
  })

  test('the last allowed attempt that fails ends the import processing_failed and removes the CSV', async () => {
    const h = await createImportHarness({ env: { INGESTION_MAX_ATTEMPTS: '1' } })
    const id = await upload(h, csv(['A,open,,,,']))
    h.deps.database.failNext(DEAL_IMPORT_APPLY, new Error('boom'))

    await h.runImports()

    expect(await read(h, id)).toMatchObject({ state: 'failed', failureReason: 'processing_failed' })
    expect(await h.objectKeys()).toEqual([])
    expect(h.deps.reported).toHaveLength(1)
  })
})

describe('the import gate and the shared pool', () => {
  test('IMPORTS_ENABLED=false claims nothing; WORKERS_ENABLED=false does not stop imports', async () => {
    const off = await createImportHarness({ env: { IMPORTS_ENABLED: 'false' } })
    const id = await upload(off, csv(['A,open,,,,']))
    expect(await off.runImports()).toBe(0)
    expect(await read(off, id)).toMatchObject({ state: 'uploaded' })

    const on = await createImportHarness({ env: { WORKERS_ENABLED: 'false' } })
    const onId = await upload(on, csv(['A,open,,,,']))
    expect(await on.runImports()).toBe(1)
    expect(await read(on, onId)).toMatchObject({ state: 'completed' })
  })

  test('shares INGESTION_CONCURRENCY with document jobs: one slot runs one import per pass', async () => {
    const h = await createImportHarness({ env: { INGESTION_CONCURRENCY: '1' } })
    await upload(h, csv(['A,open,,,,']))
    await upload(h, csv(['B,open,,,,']))

    const first = await h.deps.workers.ingestion.runPass()
    const second = await h.deps.workers.ingestion.runPass()

    expect([first, second]).toEqual([1, 1])
    expect(
      dealsOf(h)
        .map((d) => d.deal_id)
        .sort()
    ).toEqual(['A', 'B'])
  })

  test('one Organization with many queued imports cannot take every slot: a pass claims one per Organization', async () => {
    const h = await createImportHarness({ env: { INGESTION_CONCURRENCY: '2' } })
    const stranger = personIn(newOrganizationId(), 'owner')
    for (let i = 0; i < 5; i++) {
      await upload(h, csv([`A${i},open,,,,`]), newKey())
    }
    const otherResponse = await h.uploadCsv(csv(['B,open,,,,']), { as: stranger })
    expect(otherResponse.status).toBe(202)

    const ran = await h.deps.workers.ingestion.runPass()

    expect(ran).toBe(2)
    const states = (organizationId: string) =>
      h.deps.database.imports(organizationId).map((i) => i.state)
    expect(states(stranger.organizationId)).toEqual(['completed'])
    expect(states(h.organizationId).filter((state) => state === 'completed')).toHaveLength(1)
    expect(states(h.organizationId).filter((state) => state === 'uploaded')).toHaveLength(4)
  })
})

describe('isolation and secrecy', () => {
  test('an import of one Organization never reads or changes the Deals of another', async () => {
    const h = await createImportHarness()
    const other = organizationIdSchema.parse(newOrganizationId())
    h.deps.database.seedDeal({ id: deal(9), organization_id: other, deal_id: 'A', outcome: 'open' })
    const id = await upload(h, csv(['A,won,,,,']))

    await h.runImports()

    expect(h.deps.database.deals(other).map((d) => [d.deal_id, d.outcome, d.outcome_seq])).toEqual([
      ['A', 'open', 0],
    ])
    expect(dealsOf(h).map((d) => [d.deal_id, d.outcome])).toEqual([['A', 'won']])
    expect(await read(h, id)).toMatchObject({ state: 'completed' })
  })

  test('no log line, error report or response carries a deal id, name or amount from a row', async () => {
    const h = await createImportHarness()
    h.deps.database.seedDeal({ id: deal(1), organization_id: h.organizationId, deal_id: SECRET_ID })
    const responses: string[] = []
    // A mix: an applied row, a rejected one, a decided Deal, a duplicate, an invalid amount.
    const id = await upload(
      h,
      csv([
        `${SECRET_ID},won,2026-01-01,${SECRET_AMOUNT},USD,${SECRET_NAME}`,
        `${SECRET_ID},won,,,,`,
        `Other-${SECRET_ID},won,,not-money-${SECRET_AMOUNT},USD,${SECRET_NAME}`,
        `Third-${SECRET_ID},lost,,,,${SECRET_NAME}`,
      ])
    )
    h.deps.database.failNext(DEAL_IMPORT_APPLY, new Error(`connection lost near ${SECRET_ID}`))

    await h.runImports()
    await h.deps.time.advance(700_000)
    await h.runImports()
    responses.push(JSON.stringify(await read(h, id)))
    responses.push(JSON.stringify(await h.report(id)))
    responses.push(await (await h.send('GET', `${IMPORTS}?limit=5`)).text())
    // The report may carry a valid deal id (the contract allows it) but never a name or amount.
    const everything = [
      ...h.deps.logLines,
      ...h.deps.reported.map((r) => JSON.stringify(r.context)),
      ...h.deps.reported.map((r) => (r.error instanceof Error ? r.error.name : 'x')),
    ].join('\n')

    for (const secret of [SECRET_ID, SECRET_NAME, SECRET_AMOUNT]) {
      expect(everything).not.toContain(secret)
    }
    for (const secret of [SECRET_NAME, SECRET_AMOUNT]) {
      expect(responses.join('\n')).not.toContain(secret)
    }
    expect(responses[0]).not.toContain(SECRET_ID)
  })
})
