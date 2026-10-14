import { expect, test } from 'bun:test'
import { dealImportSchema, MAX_DEAL_IMPORT_ROWS } from 'tula-closeline-contract'
import { APPLY_BATCH_ROWS, judge, parseImportFile } from '../src/modules/deal-import/job'
import { createImportHarness, csv } from '../src/modules/deal-import/test-support'
import { measure, summary } from './measure'

// The Deal import job on a file of the largest size in rows (50,000, about 4 MB). Two tests:
//
// 1. The job's own CPU and copying work, which is what a request of the fleet pays: the UTF-8
//    decode and the contract's CSV parse of the whole file, the row check of every record, and the
//    JSON serialisation of 100 batches of 500 rows (the apply statement's payload). Complexity is
//    O(rows): each row is parsed once, judged once and serialised once, and a batch is a fixed 500
//    rows, so the work per apply round trip does not grow with the file.
//    Typical best run: 68 ms for the whole file. Budget: 7x, rounded up.
// 2. The whole job against the database double: upload, claim, 100 applies, finish, and a check of
//    the report. The double clones its committed state for every transaction (that is how it rolls
//    back), so its cost grows with the number of Deals and the whole run is quadratic in the double
//    only; the real statement is one indexed insert of 500 rows per batch, which only the
//    integration suite can time. This test proves the 50,000-row path is correct end to end and
//    that memory stays bounded; its time budget is loose on purpose.
//    Typical run: 6.7 s. Budget: 5x.
//
// Memory is not streamed. The object store port and the contract's reader take the whole file (at
// most 10 MB), so the job holds the bytes, their text and the parsed records of 50,000 rows
// together and releases each batch's records once it is applied. The peak is the growth of the
// process's resident memory over the run (it includes the double's own copies of the Deals, so it
// is an upper bound for the job), asserted with a margin.
// Which number guards what: the 500 ms CPU budget below is the meaningful guard, because it times
// the job's own code. The end-to-end time is dominated by the double and only catches a hang; the
// real statement's time is the integration suite's (deal-import.integration.ts).
const CPU_BUDGET_MS = 500
const RUN_BUDGET_MS = 35_000
// Typical growth: 215 MB. Budget: about 4x.
const PEAK_BUDGET_MB = 1000
const ROWS = MAX_DEAL_IMPORT_ROWS

const deal = (n: number) => `deal_${n.toString(16).padStart(32, '0')}`
const lines = Array.from(
  { length: ROWS },
  (_, i) =>
    `${deal(i + 1)},${i % 3 === 0 ? 'lost' : 'won'},2025-03-14,${1000 + i}.50,USD,Customer ${i}`
)
const text = csv(lines)
const bytes = new TextEncoder().encode(text)

test(`deal import: parse, check and batch ${ROWS} rows is within ${CPU_BUDGET_MS} ms`, async () => {
  let batches = 0
  const result = await measure(
    () => {
      const file = parseImportFile(bytes)
      const rows = file.records.map((cells, index) => judge(index + 2, cells, file.hasName))
      for (let at = 0; at < rows.length; at += APPLY_BATCH_ROWS) {
        batches += JSON.stringify(rows.slice(at, at + APPLY_BATCH_ROWS)).length > 0 ? 1 : 0
      }
    },
    { warmup: 2, batchRequests: 1, batches: 5 }
  )

  console.log(summary(`deal import parse, check and batch ${ROWS} rows`, result))
  expect(batches).toBeGreaterThan(0)
  expect(result.bestMs).toBeLessThan(CPU_BUDGET_MS)
})

test(`deal import: ${ROWS} rows end to end against the database double are within ${RUN_BUDGET_MS} ms and ${PEAK_BUDGET_MB} MB`, async () => {
  const h = await createImportHarness({ env: { MAX_DEALS_PER_ORGANIZATION: '100000' } })
  const response = await h.uploadCsv(text)
  expect(response.status).toBe(202)
  const id = dealImportSchema.parse(await response.json()).id
  Bun.gc(true)
  const baseline = process.memoryUsage().rss
  const started = performance.now()
  await h.runImports()
  const elapsed = performance.now() - started
  const growthMb = (process.memoryUsage().rss - baseline) / 1024 / 1024

  const done = dealImportSchema.parse(
    await (await h.send('GET', `/v1/playbook/deal-imports/${id}`)).json()
  )
  expect(done).toMatchObject({
    state: 'completed',
    rowCount: ROWS,
    appliedCount: ROWS,
    rejectedCount: 0,
  })
  expect(h.deps.database.deals(h.organizationId)).toHaveLength(ROWS)
  console.log(
    `deal import ${ROWS} rows end to end: ${elapsed.toFixed(0)} ms, resident memory growth ${growthMb.toFixed(0)} MB`
  )
  expect(elapsed).toBeLessThan(RUN_BUDGET_MS)
  expect(growthMb).toBeLessThan(PEAK_BUDGET_MB)
}, 120_000)
