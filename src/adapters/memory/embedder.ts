import {
  type Embedder,
  type EmbeddingPurpose,
  type EmbedOptions,
  MAX_EMBED_TEXTS,
} from '~/ports/embedder'

/** The model name the memory embedder reports. */
export const MEMORY_EMBEDDING_MODEL = 'memory-embedder'

/** The vector length of Cohere Embed v4's default output, which the memory embedder mimics. */
export const MEMORY_EMBEDDING_DIMENSIONS = 1536

/** One call the memory embedder received, for a test to assert on. */
export type EmbedCall = { texts: readonly string[]; purpose: EmbeddingPurpose }

/** An {@link Embedder} in process memory that records its calls. */
export type MemoryEmbedder = Embedder & { readonly calls: EmbedCall[] }

/** Options of {@link createMemoryEmbedder}. */
export type MemoryEmbedderOptions = {
  /** The vector length; default {@link MEMORY_EMBEDDING_DIMENSIONS}. */
  dimensions?: number
  /** The model name; default {@link MEMORY_EMBEDDING_MODEL}. */
  model?: string
}

/** 32-bit FNV-1a, enough to spread words over the dimensions deterministically. */
function hash(word: string): number {
  let value = 0x811c9dc5
  for (const unit of new TextEncoder().encode(word)) {
    value = Math.imul(value ^ unit, 0x01000193) >>> 0
  }
  return value
}

/** The unit vector of a text: its words hashed into the dimensions, so shared words mean closeness. */
function embedText(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  // A text with no words still needs a non-zero vector: the vector store refuses all zeros.
  for (const word of words.length > 0 ? words : ['']) {
    const index = hash(word) % dimensions
    vector[index] = (vector[index] ?? 0) + 1
  }
  const length = Math.sqrt(vector.reduce((sum, part) => sum + part * part, 0))
  return vector.map((part) => part / length)
}

/** Creates a deterministic bag-of-words embedder for tests and local runs. It calls no model. */
export function createMemoryEmbedder(options: MemoryEmbedderOptions = {}): MemoryEmbedder {
  const dimensions = options.dimensions ?? MEMORY_EMBEDDING_DIMENSIONS
  const calls: EmbedCall[] = []
  return {
    model: options.model ?? MEMORY_EMBEDDING_MODEL,
    dimensions,
    calls,
    embed: async (texts: readonly string[], embedOptions: EmbedOptions) => {
      embedOptions.signal.throwIfAborted()
      if (texts.length > MAX_EMBED_TEXTS) {
        throw new RangeError(`embed takes at most ${MAX_EMBED_TEXTS} texts per call`)
      }
      calls.push({ texts: [...texts], purpose: embedOptions.purpose })
      return texts.map((text) => embedText(text, dimensions))
    },
  }
}
