import { expect, test } from 'bun:test'
import { chunkPages } from '../src/modules/ingestion/chunker'
import { measure, summary } from './measure'

// The chunker on a 300-page document (about 3 000 paragraphs, 1.2 MB of text). Complexity is
// O(total characters) in time and O(input + output) in memory; the scan never looks back, and a
// sentence search is bounded by the chunk size. Budget: about 5x the best batch, rounded up.
// Typical best batch: 25 ms for 20 documents (about 1.3 ms each). Budget: 5x, rounded up.
const BUDGET_MS = 125
const pages = Array.from({ length: 300 }, (_, i) => ({
  number: i + 1,
  text: Array.from(
    { length: 10 },
    (_, p) =>
      `${'Pricing is agreed per seat. Discounts apply after review. '.repeat(6)}\n\nPart ${p}`
  ).join('\n\n'),
}))
const options = { targetChars: 1000, maxChars: 1600, overlapChars: 150, maxChunks: 5000 }

test(`chunker: the best of batches of 20 documents of 300 pages is within ${BUDGET_MS} ms`, async () => {
  let chunks = 0
  const result = await measure(
    () => {
      chunks = chunkPages(pages, options).length
    },
    { warmup: 20, batchRequests: 20, batches: 5 }
  )

  console.log(summary('chunker', result))
  expect(chunks).toBeGreaterThan(0)
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
}, 60_000)
