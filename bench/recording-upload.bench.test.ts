import { expect, spyOn, test } from 'bun:test'
import { MAX_RECORDING_BYTES } from 'tula-closeline-contract'
import { CALLS, createCallHarness, wavBytes } from '../src/modules/call/test-support'

// The Recording upload route with a 500 MiB file (the limit): the body is parsed as a stream and
// passed to the object store's `putStream` in the sender's chunks, so the memory the route and
// service add is a few chunks, whatever the file's size. Complexity: O(file size) time (one pass:
// the cap's counter, the boundary search and the store's own hash), O(1) memory (a chunk and a
// boundary's worth of look-behind). The store here counts, hashes and drops what it reads, as the
// real one holds only its parts (kit `bench/storage-stream.bench.ts`: about 25 MiB for 500 MiB), so
// what this measures is the route and service layer. The database is the double.
// Typical: about 0.4 s and 35 MiB of resident growth locally. Budgets: 30 s (shared CI
// runners) and 96 MiB of growth, far below the 500 MiB a buffering route would add.
const TIME_BUDGET_MS = 30_000
const MEMORY_BUDGET_BYTES = 96 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024

test('a 500 MiB Recording upload streams through with flat memory', async () => {
  const h = await createCallHarness()
  let total = 0
  let peakRss = 0
  spyOn(h.deps.objects, 'putStream').mockImplementation(async (_org, _key, body) => {
    const hasher = new Bun.CryptoHasher('sha256')
    let seen = 0
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      hasher.update(chunk)
      total += chunk.byteLength
      if (++seen % 16 === 0) {
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
      }
    }
    return { size: total, sha256: hasher.digest('hex') }
  })
  const chunk = wavBytes('bench', CHUNK_BYTES)
  const head = new TextEncoder().encode(
    '--B\r\nContent-Disposition: form-data; name="dealId"\r\n\r\nDEAL-1\r\n' +
      '--B\r\nContent-Disposition: form-data; name="file"; filename="bench.wav"\r\nContent-Type: audio/wav\r\n\r\n'
  )
  let remaining = MAX_RECORDING_BYTES
  let started = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true
        controller.enqueue(head)
      }
      if (remaining > 0) {
        const next = chunk.subarray(0, Math.min(remaining, chunk.byteLength))
        remaining -= next.byteLength
        controller.enqueue(next)
        return
      }
      controller.enqueue(new TextEncoder().encode('\r\n--B--\r\n'))
      controller.close()
    },
  })
  const headers = {
    ...(await h.bearer(h.people.owner)),
    'content-type': 'multipart/form-data; boundary=B',
  }
  Bun.gc(true)
  const before = process.memoryUsage().rss
  const started_at = performance.now()

  const response = await h.app.request(CALLS, { method: 'POST', body, duplex: 'half', headers })

  const elapsed = performance.now() - started_at
  const growth = Math.max(0, peakRss - before)
  console.log(
    `recording upload: ${Math.round(total / 1048576)} MiB in ${Math.round(elapsed)} ms, resident growth ${Math.round(growth / 1048576)} MiB`
  )
  expect(response.status).toBe(201)
  expect(total).toBe(MAX_RECORDING_BYTES)
  expect(elapsed).toBeLessThan(TIME_BUDGET_MS)
  expect(growth).toBeLessThan(MEMORY_BUDGET_BYTES)
}, 120_000)
