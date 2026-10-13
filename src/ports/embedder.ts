/**
 * The most texts one {@link Embedder.embed} call takes. Cohere Embed v4 accepts 96 texts per
 * request (ADR 0010), and a batch is the unit of one outbound call, timeout and retry.
 */
export const MAX_EMBED_TEXTS = 96

/** What an embedding is for: the Playbook's text chunks, or a live query searched against them. */
export type EmbeddingPurpose = 'document' | 'query'

/** Options of one {@link Embedder.embed} call. */
export type EmbedOptions = {
  purpose: EmbeddingPurpose
  /** Aborts the call, over and above the adapter's own timeout. */
  signal: AbortSignal
}

/**
 * Turns text into vectors (ADR 0010: Cohere Embed v4 on Bedrock). Vectors from two models cannot
 * be compared, so the model name and dimension count are stored per Organization and a switch
 * means re-embedding every Playbook.
 */
export interface Embedder {
  /** The model's name, as recorded in the Organization's index settings. */
  readonly model: string
  /** The length of every vector this embedder returns. */
  readonly dimensions: number
  /**
   * One vector per text, in order, for at most {@link MAX_EMBED_TEXTS} texts (a `RangeError`
   * otherwise: the caller splits). Text is untrusted data, never instructions. Rejects when
   * `options.signal` aborts. Every call has its own timeout and a bounded, jittered retry inside the adapter (COMMON.md); the caller passes a signal to cancel it, and retries nothing itself.
   */
  embed(texts: readonly string[], options: EmbedOptions): Promise<number[][]>
}
