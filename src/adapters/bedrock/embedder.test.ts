import { describe, expect, test } from 'bun:test'
import { embedderBehaviour } from '~/ports/embedder.behaviour'
import { createBedrockEmbedder, type TitanSender } from './embedder'

const signal = new AbortController().signal
const options = { purpose: 'document', signal } as const

function fake(dimensions: number, log: string[] = []): TitanSender {
  return async (body) => {
    const { inputText } = JSON.parse(body) as { inputText: string }
    log.push(inputText)
    return { embedding: Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0.1)) }
  }
}

const make = (send: TitanSender, extra = {}) =>
  createBedrockEmbedder({
    region: 'us-east-1',
    dimensions: 256,
    timeoutMs: 1_000,
    send,
    sleep: async () => {},
    ...extra,
  })

embedderBehaviour('bedrock embedder (fake sender)', () => make(fake(256)))

describe('bedrock embedder', () => {
  test('keeps order across concurrent calls and replaces an empty text', async () => {
    const seen: string[] = []
    const texts = Array.from({ length: 20 }, (_, i) => (i === 3 ? '' : `t${i}`))
    const vectors = await make(fake(256, seen)).embed(texts, options)
    expect(vectors).toHaveLength(20)
    expect(seen).toContain(' ')
  })

  test('retries a throttle then succeeds; gives up on a permanent error without leaking its message', async () => {
    let calls = 0
    const throttled: TitanSender = async (body) => {
      calls++
      if (calls < 3) {
        throw Object.assign(new Error('secret text'), {
          name: 'ThrottlingException',
          $metadata: { httpStatusCode: 429 },
        })
      }
      return fake(256)(body, signal)
    }
    await make(throttled).embed(['a'], options)
    expect(calls).toBe(3)

    let denied = 0
    const forbidden: TitanSender = async () => {
      denied++
      throw Object.assign(new Error('secret text'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 403 },
      })
    }
    const error = await make(forbidden)
      .embed(['a'], options)
      .catch((e: Error) => e)
    expect(denied).toBe(1)
    expect((error as Error).message).toBe(
      'embedder.unavailable: Bedrock AccessDeniedException (403)'
    )
  })

  test('a wrong-length embedding is refused', async () => {
    await expect(make(fake(128)).embed(['a'], options)).rejects.toThrow(/unexpected embedding/)
  })

  test('the deadline cuts a hung call', async () => {
    const hang: TitanSender = (_body, abort) =>
      new Promise((_, reject) => abort.addEventListener('abort', () => reject(abort.reason)))
    await expect(make(hang, { timeoutMs: 20 }).embed(['a'], options)).rejects.toThrow()
  })

  test('more than 96 texts is a RangeError', async () => {
    await expect(make(fake(256)).embed(new Array(97).fill('a'), options)).rejects.toThrow(
      RangeError
    )
  })
})
