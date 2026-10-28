import { describe, expect, test } from 'bun:test'
import { embedderBehaviour } from '~/ports/embedder.behaviour'
import { type CohereSender, createBedrockEmbedder } from './embedder'

const signal = new AbortController().signal
const options = { purpose: 'document', signal } as const

type Request = { modelId: string; body: { texts: string[]; input_type: string } }

function fake(dimensions: number, log: Request[] = []): CohereSender {
  return async (modelId, body) => {
    const parsed = JSON.parse(body) as Request['body']
    log.push({ modelId, body: parsed })
    return {
      embeddings: {
        float: parsed.texts.map(() =>
          Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0.1))
        ),
      },
    }
  }
}

const make = (send: CohereSender, extra = {}) =>
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
  test('sends one call per batch through the Region profile, with the purpose as input_type', async () => {
    const log: Request[] = []
    const texts = Array.from({ length: 96 }, (_, i) => (i === 3 ? '' : `t${i}`))
    const vectors = await make(fake(256, log)).embed(texts, options)
    await make(fake(256, log), { region: 'eu-west-1' }).embed(['q'], { purpose: 'query', signal })

    expect(vectors).toHaveLength(96)
    expect(log).toHaveLength(2)
    expect(log[0]?.modelId).toBe('us.cohere.embed-v4:0')
    expect(log[0]?.body.input_type).toBe('search_document')
    expect(log[0]?.body.texts[3]).toBe(' ')
    expect(log[1]?.modelId).toBe('eu.cohere.embed-v4:0')
    expect(log[1]?.body.input_type).toBe('search_query')
  })

  test('refuses a Region with no inference profile', () => {
    expect(() => make(fake(256), { region: 'sa-east-1' })).toThrow(/profile/)
  })

  test('retries a throttle then succeeds; gives up on a permanent error without leaking its message', async () => {
    let calls = 0
    const throttled: CohereSender = async (modelId, body, abort) => {
      calls++
      if (calls < 3) {
        throw Object.assign(new Error('secret text'), {
          name: 'ThrottlingException',
          $metadata: { httpStatusCode: 429 },
        })
      }
      return fake(256)(modelId, body, abort)
    }
    await make(throttled).embed(['a'], options)
    expect(calls).toBe(3)

    let denied = 0
    const forbidden: CohereSender = async () => {
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

  test('a wrong-length or wrong-count answer is refused', async () => {
    await expect(make(fake(128)).embed(['a'], options)).rejects.toThrow(/embedder.unavailable/)
    const short: CohereSender = async () => ({ embeddings: { float: [] } })
    await expect(make(short).embed(['a'], options)).rejects.toThrow(/embedder.unavailable/)
  })

  test('the deadline cuts a hung call', async () => {
    const hang: CohereSender = (_m, _b, abort) =>
      new Promise((_, reject) => abort.addEventListener('abort', () => reject(abort.reason)))
    await expect(make(hang, { timeoutMs: 20 }).embed(['a'], options)).rejects.toThrow()
  })

  test('more than 96 texts is a RangeError', async () => {
    await expect(make(fake(256)).embed(new Array(97).fill('a'), options)).rejects.toThrow(
      RangeError
    )
  })
})
