import { describe, expect, test } from 'bun:test'
import { createVoiceHttpRecordings } from './recordings'

const TOKEN = 'voice-secret-token-0123456789-abcdef'
const ORG = `org_${'1'.repeat(32)}`
const CALL = `call_${'a'.repeat(32)}`
const signal = new AbortController().signal

type Reply = Response | Error

/** An adapter over a scripted fetch; `seen` records every request. */
function setup(replies: Reply[]) {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const queue = [...replies]
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> })
    const next = queue.shift()
    if (next === undefined || next instanceof Error) {
      throw next ?? new Error('script exhausted')
    }
    return next
  }) as unknown as typeof fetch
  const recordings = createVoiceHttpRecordings({
    baseUrl: 'https://voice.test/',
    token: TOKEN,
    fetch: fetcher,
    sleep: async () => undefined,
    random: () => 0,
  })
  return { recordings, seen }
}

async function drain(stream: AsyncIterable<Uint8Array> | null): Promise<number[]> {
  const bytes: number[] = []
  for await (const chunk of stream ?? []) {
    bytes.push(...chunk)
  }
  return bytes
}

describe('fetching a Recording from voice', () => {
  test('streams the body and sends the secret, the Organization and the Call id', async () => {
    const { recordings, seen } = setup([new Response(new Uint8Array([1, 2, 3]), { status: 200 })])

    const stream = await recordings.open(ORG, CALL, { signal })

    expect(await drain(stream)).toEqual([1, 2, 3])
    expect(seen[0]?.url).toBe(`https://voice.test/internal/v1/calls/${CALL}/recording`)
    expect(seen[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-organization-id': ORG,
    })
  })

  test('a 404 means voice has no Recording', async () => {
    const { recordings } = setup([new Response(null, { status: 404 })])
    expect(await recordings.open(ORG, CALL, { signal })).toBeNull()
  })

  test('a 503 is retried and then succeeds', async () => {
    const { recordings, seen } = setup([
      new Response(null, { status: 503 }),
      new Response(new Uint8Array([9]), { status: 200 }),
    ])
    expect(await drain(await recordings.open(ORG, CALL, { signal }))).toEqual([9])
    expect(seen).toHaveLength(2)
  })

  test('a 503 on every attempt, and a network error, end as server.unavailable after the retries', async () => {
    const down = setup([503, 503, 503].map((status) => new Response(null, { status })))
    await expect(down.recordings.open(ORG, CALL, { signal })).rejects.toMatchObject({
      code: 'server.unavailable',
    })
    expect(down.seen).toHaveLength(3)
    const broken = setup([new Error('boom'), new Error('boom'), new Error('boom')])
    await expect(broken.recordings.open(ORG, CALL, { signal })).rejects.toMatchObject({
      code: 'server.unavailable',
    })
  })

  test('a timeout ends as server.timeout, and neither error carries the secret', async () => {
    const timeout = Object.assign(new Error('slow'), { name: 'TimeoutError' })
    const { recordings } = setup([timeout, timeout, timeout])
    const error = await recordings.open(ORG, CALL, { signal }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'server.timeout' })
    expect(JSON.stringify(error) + String(error)).not.toContain(TOKEN)
  })

  test('a 401 or a 409 is not retried and is server.unavailable', async () => {
    for (const status of [401, 409]) {
      const { recordings, seen } = setup([new Response(null, { status })])
      await expect(recordings.open(ORG, CALL, { signal })).rejects.toMatchObject({
        code: 'server.unavailable',
      })
      expect(seen).toHaveLength(1)
    }
  })
})
