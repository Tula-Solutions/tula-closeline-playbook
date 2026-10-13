/** What an embedding is for: the Playbook's text chunks, or a live query searched against them. */
export type EmbeddingPurpose = 'document' | 'query'

/** Options of one {@link Embedder.embed} call. */
export type EmbedOptions = {
  purpose: EmbeddingPurpose
  /** Aborts the call; an adapter also bounds it with its own timeout. */
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
   * One vector per text, in order. Text is untrusted data, never instructions. Rejects when
   * `options.signal` aborts; a failure is retried by the caller, not inside the adapter.
   */
  embed(texts: readonly string[], options: EmbedOptions): Promise<number[][]>
}
