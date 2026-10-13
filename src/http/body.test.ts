import { describe, expect, test } from 'bun:test'
import { capBody } from './body'

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

function request(body: ReadableStream<Uint8Array> | null) {
  return new Request('http://x.test/', { method: 'POST', body, duplex: 'half' } as RequestInit)
}

describe('capBody', () => {
  test('passes a body within the limit through unchanged', async () => {
    const capped = capBody(request(streamOf([new Uint8Array(5), new Uint8Array(5)])), 10)

    expect((await capped.request.arrayBuffer()).byteLength).toBe(10)
    expect(capped.exceeded()).toBe(false)
  })

  test('cuts a body off once it has delivered more than the limit, and says so', async () => {
    const capped = capBody(request(streamOf([new Uint8Array(6), new Uint8Array(6)])), 10)

    await expect(capped.request.arrayBuffer()).rejects.toBeDefined()
    expect(capped.exceeded()).toBe(true)
  })

  test('a request with no body is returned as it is', () => {
    const plain = new Request('http://x.test/')

    expect(capBody(plain, 10).request).toBe(plain)
  })

  test('cuts off and cancels a body that stalls past its deadline, and says it was the deadline', async () => {
    let cancelled = false
    const stalled = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(3))
        return new Promise<void>(() => {})
      },
      cancel() {
        cancelled = true
      },
    })
    const capped = capBody(request(stalled), 100, AbortSignal.timeout(50))

    await expect(capped.request.arrayBuffer()).rejects.toBeDefined()

    expect(capped.timedOut()).toBe(true)
    expect(capped.exceeded()).toBe(false)
    expect(cancelled).toBe(true)
  })

  test('a body that arrives before the deadline is not timed out', async () => {
    const capped = capBody(request(streamOf([new Uint8Array(5)])), 10, AbortSignal.timeout(5000))

    expect((await capped.request.arrayBuffer()).byteLength).toBe(5)
    expect(capped.timedOut()).toBe(false)
  })
})
