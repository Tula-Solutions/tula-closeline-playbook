import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { type Embedder, type EmbedOptions, MAX_EMBED_TEXTS } from '~/ports/embedder'

/** The model's name, as recorded in the Organization's index settings. */
export const COHERE_EMBEDDING_MODEL = 'cohere.embed-v4:0'

/** The vector lengths Cohere Embed v4 can return (`output_dimension`). */
export const COHERE_DIMENSIONS = [256, 512, 1024, 1536] as const

/** Sends one InvokeModel request to a model id; the real client, or a double in tests. */
export type CohereSender = (
  modelId: string,
  body: string,
  abortSignal: AbortSignal
) => Promise<{ embeddings?: { float?: unknown } }>

/** Options of {@link createBedrockEmbedder}. */
export type BedrockEmbedderOptions = {
  /** The AWS Region of the Bedrock endpoint; its geography picks the inference profile. */
  region: string
  /** The vector length; default 1536. */
  dimensions?: (typeof COHERE_DIMENSIONS)[number]
  /** The longest one `embed` call may take, retries included, in ms. */
  timeoutMs: number
  /** Retries after the first attempt; default 2. */
  maxRetries?: number
  /** Pause base in ms, doubled and jittered; default 200. */
  baseDelayMs?: number
  /** Replaces the Bedrock client; for tests. */
  send?: CohereSender
  /** A number in [0, 1) for the jitter. */
  random?: () => number
  /** Pauses between retries; a timer by default. */
  sleep?: (ms: number) => Promise<void>
}

/** The inference profile prefix of a Region; never `global.`, which could leave the geography. */
function profileOf(region: string): string {
  if (region.startsWith('us-') && !region.startsWith('us-gov-')) {
    return 'us'
  }
  if (region.startsWith('eu-')) {
    return 'eu'
  }
  throw new TypeError(`no Cohere Embed v4 inference profile is configured for ${region}`)
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

function sdkSender(region: string): CohereSender {
  const client = new BedrockRuntimeClient({
    region,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
  })
  return async (modelId, body, abortSignal) => {
    const out = await client.send(
      new InvokeModelCommand({
        modelId,
        body,
        contentType: 'application/json',
        accept: 'application/json',
      }),
      { abortSignal }
    )
    return JSON.parse(new TextDecoder().decode(out.body)) as { embeddings?: { float?: unknown } }
  }
}

/**
 * Creates an {@link Embedder} on Amazon Bedrock with Cohere Embed v4 (ADR 0010) through the
 * Region's inference profile. One call per batch of at most 96 texts, with the call's deadline and
 * a bounded, jittered retry of transient failures; the SDK's own retry is off. `purpose` maps to
 * `search_document` / `search_query`. Text is never logged or put in an error. O(n) in the texts.
 */
export function createBedrockEmbedder(options: BedrockEmbedderOptions): Embedder {
  const dimensions = options.dimensions ?? 1536
  const maxRetries = options.maxRetries ?? 2
  const baseDelayMs = options.baseDelayMs ?? 200
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const modelId = `${profileOf(options.region)}.${COHERE_EMBEDDING_MODEL}`
  const send = options.send ?? sdkSender(options.region)

  return {
    model: COHERE_EMBEDDING_MODEL,
    dimensions,
    embed: async (texts: readonly string[], embedOptions: EmbedOptions) => {
      embedOptions.signal.throwIfAborted()
      if (texts.length > MAX_EMBED_TEXTS) {
        throw new RangeError(`embed takes at most ${MAX_EMBED_TEXTS} texts per call`)
      }
      if (texts.length === 0) {
        return []
      }
      const signal = AbortSignal.any([embedOptions.signal, AbortSignal.timeout(options.timeoutMs)])
      // A blank text is refused by the model; a space embeds as a (meaningless) vector.
      const body = JSON.stringify({
        texts: texts.map((text) => (text.trim() === '' ? ' ' : text)),
        input_type: embedOptions.purpose === 'query' ? 'search_query' : 'search_document',
        embedding_types: ['float'],
        output_dimension: dimensions,
        truncate: 'END',
      })
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted()
        try {
          const vectors = (await send(modelId, body, signal)).embeddings?.float
          if (
            !Array.isArray(vectors) ||
            vectors.length !== texts.length ||
            !vectors.every(
              (v) =>
                Array.isArray(v) &&
                v.length === dimensions &&
                v.every((n) => typeof n === 'number' && Number.isFinite(n))
            )
          ) {
            throw new Error('embedder.unavailable: Bedrock returned an unexpected embedding')
          }
          return vectors as number[][]
        } catch (error) {
          if (signal.aborted || attempt >= maxRetries || !isTransient(error)) {
            throw signal.aborted ? signal.reason : reduce(error)
          }
          await sleep(Math.min(baseDelayMs * 2 ** attempt, 2_000) * (0.5 + random() / 2))
        }
      }
    },
  }
}
