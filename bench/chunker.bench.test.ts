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
    async () => {
      chunks = (await chunkPages(pages, options)).length
    },
    { warmup: 20, batchRequests: 20, batches: 5 }
  )

  console.log(summary('chunker', result))
  expect(chunks).toBeGreaterThan(0)
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
}, 60_000)

// The hostile shapes: a heading line or a paragraph that is one run of spaces. The scan is linear,
// so the cost is that of the characters, not their square. Typical best batch: 70 ms for 5 runs of
// 1 MB (about 14 ms each). Budget: 5x, rounded up, which an O(n^2) scan overshoots by 100x.
const HOSTILE_BUDGET_MS = 350
const hostile = [
  ['a heading followed by a million spaces', `# a${' '.repeat(1_000_000)}b`],
  ['a million spaces inside a line', `start${' '.repeat(1_000_000)}end`],
] as const

test.each(hostile)(
  `chunker, hostile input (%s): the best of batches of 5 is within ${HOSTILE_BUDGET_MS} ms`,
  async (_name, text) => {
    const input = [{ number: 1, text }]
    const result = await measure(
      async () => {
        await chunkPages(input, { ...options, maxChunks: 100_000 })
      },
      { warmup: 3, batchRequests: 5, batches: 5 }
    )

    console.log(summary('chunker hostile', result))
    expect(result.bestMs).toBeLessThan(HOSTILE_BUDGET_MS)
  },
  60_000
)
