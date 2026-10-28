import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { type Embedder, type EmbedOptions, MAX_EMBED_TEXTS } from '~/ports/embedder'

/** The Bedrock model id of the embedder. */
export const TITAN_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'

/** The vector lengths Titan Text Embeddings V2 can return. */
export const TITAN_DIMENSIONS = [256, 512, 1024] as const

/** The longest text Titan takes (50,000 characters); a longer one is cut, as a chunk never is. */
const MAX_TEXT_CHARS = 50_000

/** Titan takes one text per call, so a batch is this many calls at once. */
const CONCURRENCY = 8

/** Sends one InvokeModel request; the real client, or a double in tests. */
export type TitanSender = (
  body: string,
  abortSignal: AbortSignal
) => Promise<{ embedding: unknown }>

/** Options of {@link createBedrockEmbedder}. */
export type BedrockEmbedderOptions = {
  /** The AWS Region of the Bedrock endpoint. */
  region: string
  /** The vector length; default 1024. */
  dimensions?: (typeof TITAN_DIMENSIONS)[number]
  /** The longest one `embed` call may take, retries included, in ms. */
  timeoutMs: number
  /** Retries after the first attempt of one text; default 2. */
  maxRetries?: number
  /** Pause base in ms, doubled and jittered; default 200. */
  baseDelayMs?: number
  /** Replaces the Bedrock client; for tests. */
  send?: TitanSender
  /** A number in [0, 1) for the jitter. */
  random?: () => number
  /** Pauses between retries; a timer by default. */
  sleep?: (ms: number) => Promise<void>
}

type SdkLikeError = {
  name?: unknown
  $fault?: unknown
  $retryable?: unknown
  $metadata?: { httpStatusCode?: unknown }
}

/** True when trying again can succeed: throttling, 5xx, timeouts; a client fault is permanent. */
function isTransient(error: unknown): boolean {
  const e = (typeof error === 'object' && error !== null ? error : {}) as SdkLikeError
  const status = e.$metadata?.httpStatusCode
  if (typeof status === 'number') {
    return status >= 500 || status === 408 || status === 429
  }
  return e.$retryable !== undefined || e.$fault === 'server' || e.name === 'TimeoutError'
}

/** Keeps only the SDK error's name and status: its message can repeat the request. */
function reduce(error: unknown): Error {
  const e = (typeof error === 'object' && error !== null ? error : {}) as SdkLikeError
  const name =
    typeof e.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(e.name) ? e.name : 'Error'
  const status = e.$metadata?.httpStatusCode
  return new Error(
    `embedder.unavailable: Bedrock ${name}${typeof status === 'number' ? ` (${status})` : ''}`
  )
}

function sdkSender(region: string, model: string): TitanSender {
  const client = new BedrockRuntimeClient({
    region,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  })
  return async (body, abortSignal) => {
    const out = await client.send(
      new InvokeModelCommand({
        modelId: model,
        body,
        contentType: 'application/json',
        accept: 'application/json',
      }),
      { abortSignal }
    )
    return JSON.parse(new TextDecoder().decode(out.body)) as { embedding: unknown }
  }
}

/**
 * Creates an {@link Embedder} on Amazon Bedrock with Titan Text Embeddings V2 (normalised
 * vectors). Titan has no query/document distinction, so `purpose` is ignored. Text is never
 * logged or put in an error. O(n) calls of at most 8 at once, each with the call's deadline and
 * a bounded, jittered retry of transient failures; the SDK's own retry is off.
 */
export function createBedrockEmbedder(options: BedrockEmbedderOptions): Embedder {
  const dimensions = options.dimensions ?? 1024
  const maxRetries = options.maxRetries ?? 2
  const baseDelayMs = options.baseDelayMs ?? 200
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const send = options.send ?? sdkSender(options.region, TITAN_EMBEDDING_MODEL)

  async function one(text: string, signal: AbortSignal): Promise<number[]> {
    // Titan refuses an empty text; a space embeds as a (meaningless) non-zero vector.
    const inputText = text.trim() === '' ? ' ' : text.slice(0, MAX_TEXT_CHARS)
    const body = JSON.stringify({ inputText, dimensions, normalize: true })
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      try {
        const { embedding } = await send(body, signal)
        if (
          !Array.isArray(embedding) ||
          embedding.length !== dimensions ||
          !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))
        ) {
          throw new Error('embedder.unavailable: Bedrock returned an unexpected embedding')
        }
        return embedding as number[]
      } catch (error) {
        if (signal.aborted || attempt >= maxRetries || !isTransient(error)) {
          throw signal.aborted ? signal.reason : reduce(error)
        }
        await sleep(Math.min(baseDelayMs * 2 ** attempt, 2_000) * (0.5 + random() / 2))
      }
    }
  }

  return {
    model: TITAN_EMBEDDING_MODEL,
    dimensions,
    embed: async (texts: readonly string[], embedOptions: EmbedOptions) => {
      embedOptions.signal.throwIfAborted()
      if (texts.length > MAX_EMBED_TEXTS) {
        throw new RangeError(`embed takes at most ${MAX_EMBED_TEXTS} texts per call`)
      }
      const failed = new AbortController()
      const signal = AbortSignal.any([
        embedOptions.signal,
        AbortSignal.timeout(options.timeoutMs),
        failed.signal,
      ])
      const vectors: number[][] = new Array(texts.length)
      let next = 0
      const worker = async () => {
        while (next < texts.length) {
          const index = next++
          vectors[index] = await one(texts[index] as string, signal)
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker))
      } catch (error) {
        failed.abort() // stop the sibling calls once one text has failed for good
        throw error
      }
      return vectors
    },
  }
}
