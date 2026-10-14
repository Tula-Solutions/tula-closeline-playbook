import { expect, test } from 'bun:test'
import { MAX_TRANSCRIPT_BYTES } from 'tula-closeline-contract'
import { buildMoments } from '../src/modules/call/moments'
import { MAX_TURNS_PER_CALL, parseTranscript } from '../src/modules/call/transcript'
import { measure, summary } from './measure'

// Parsing and Moment building for a Transcript at the 5 MB limit. Complexity is O(file size) in
// time: the parse reads the text once and the Moment window is a constant (6 turns, 2000 code
// points), so building is O(turns). Memory is the text and the turns once, plus one Moment per
// Prospect turn: the turn limit (10 000) bounds the Moments, and each holds at most the window's
// characters. Typical best batch: 91 ms for 3 files (about 30 ms each) locally. Budget: about 6.5x,
// with room for shared CI runners.
const BUDGET_MS = 600

// About 5 MB of plain text in 8 000 turns of about 650 bytes, alternating Rep and Prospect.
const LINE = 'The quarterly pricing review covers seats, discounts and renewal terms. '.repeat(9)
const turns: string[] = []
let size = 0
for (let i = 0; size < MAX_TRANSCRIPT_BYTES - 2000 && turns.length < MAX_TURNS_PER_CALL - 1; i++) {
  const line = `${i % 2 === 0 ? 'Alex' : 'Sam'}: ${LINE}${i}`
  turns.push(line)
  size += line.length + 1
}
const body = new TextEncoder().encode(`${turns.join('\n')}\n`)

test(`Transcript parse and Moments: the best of batches of 3 files of ${Math.round(body.byteLength / 1_000_000)} MB is within ${BUDGET_MS} ms`, async () => {
  let moments = 0
  const result = await measure(
    async () => {
      const parsed = parseTranscript(body, 'text/plain')
      if (!parsed.ok) {
        throw new Error('the benchmark file did not parse')
      }
      moments = buildMoments(parsed.transcript.turns, 'Alex').length
    },
    { warmup: 1, batchRequests: 3, batches: 3 }
  )

  console.log(summary('call transcript', result))
  expect(body.byteLength).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES)
  expect(moments).toBeGreaterThan(1000)
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
}, 120_000)

// The hostile shape: two speaker lines, then about a million short continuation lines. Each line
// costs work proportional to itself, not to the turn built so far (a turn stops growing at its cap).
// Typical best batch: see the log line; budget generous for CI runners, far under the quadratic cost.
const HOSTILE_BUDGET_MS = 3000
const hostile = new TextEncoder().encode(`A: start\nB: reply\n${'xx\n'.repeat(1_400_000)}`)

test(`Transcript parse, hostile continuation lines: the best of 3 is within ${HOSTILE_BUDGET_MS} ms`, async () => {
  const result = await measure(
    async () => {
      const parsed = parseTranscript(hostile, 'text/plain')
      if (!parsed.ok) {
        throw new Error('the hostile file did not parse')
      }
    },
    { warmup: 1, batchRequests: 1, batches: 3 }
  )

  console.log(summary('call transcript hostile', result))
  expect(result.bestMs).toBeLessThan(HOSTILE_BUDGET_MS)
}, 120_000)
