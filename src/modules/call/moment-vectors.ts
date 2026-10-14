import { momentSnippet } from 'tula-closeline-contract'
import { PermanentFailure, type PipelineDeps, within } from '~/modules/ingestion/runtime'
import { MAX_EMBED_TEXTS } from '~/ports/embedder'
import { momentVectorId } from './keys'
import type { Moment } from './moments'

/** What writing one build's Moment vectors needs: the Call's build, a cancel signal and two hooks. */
export type MomentWriteContext = {
  deps: PipelineDeps
  organizationId: string
  callId: string
  epoch: number
  repSeq: number
  /** Aborts on shutdown or on a lost claim: passed to every call. */
  signal: AbortSignal
  /** Runs before each write: a job renews its lease here and throws when the claim is gone. */
  beforeWrite: () => Promise<void>
  /** Told of each write the moment it starts, so a caller can tell whether one is still in flight. */
  track?: (write: Promise<void>) => void
}

/** The version of a Moment vector's attributes: 2 carries the snippets a search returns. Search filters on it. */
export const MOMENT_VECTOR_VERSION = 2

/** The vector store's limit on an attribute string, in UTF-16 units (kit's `MAX_ATTRIBUTE_STRING`). */
const MAX_ATTRIBUTE_UNITS = 512

/** A snippet cut to at most {@link MAX_ATTRIBUTE_UNITS} UTF-16 units at a code point boundary, then re-trimmed: an emoji is two units but one code point, so the contract's cap alone can overflow the store's. */
export function attributeSnippet(text: string): string {
  const snippet = momentSnippet(text)
  if (snippet.length <= MAX_ATTRIBUTE_UNITS) {
    return snippet
  }
  let end = 0
  for (const point of snippet) {
    if (end + point.length > MAX_ATTRIBUTE_UNITS) {
      break
    }
    end += point.length
  }
  return snippet.slice(0, end).trimEnd()
}

/** The text of the Prospect's turn the Moment ends on (the last context turn). */
function prospectOf(moment: Moment): string {
  return moment.context.at(-1)?.text ?? ''
}

/**
 * Embeds the Moments in batches of {@link MAX_EMBED_TEXTS} and writes each batch's vectors under
 * deterministic ids (`momentVectorId`), tagged with the Outcome and Outcome sequence given. Writing
 * the same build again overwrites, so it is safe to repeat; the tag is the only thing that differs
 * between a first build and a re-tag. A write that runs out of time may still land (the caller
 * decides what that means). Nothing here logs.
 */
export async function writeMomentVectors(
  c: MomentWriteContext,
  moments: readonly Moment[],
  tag: { outcome: string; outcomeSeq: number }
): Promise<void> {
  const { deps } = c
  const { env, embedder } = deps
  for (let start = 0; start < moments.length; start += MAX_EMBED_TEXTS) {
    c.signal.throwIfAborted()
    const batch = moments.slice(start, start + MAX_EMBED_TEXTS)
    const vectors = await within(
      deps,
      'embedder',
      env.INGESTION_IO_TIMEOUT_MS,
      c.signal,
      (signal) =>
        embedder.embed(
          batch.map((moment) => moment.text),
          { purpose: 'document', signal }
        )
    )
    if (vectors.length !== batch.length) {
      throw new Error('the embedder answered with the wrong number of vectors')
    }
    if (vectors.some((vector) => vector.length !== embedder.dimensions)) {
      throw new PermanentFailure('processing_failed')
    }
    // The claim must be alive when the write starts; the lease is longer than the write's deadline.
    await c.beforeWrite()
    await within(deps, 'vector store', env.INGESTION_IO_TIMEOUT_MS, c.signal, () => {
      const write = deps.vectors.upsert(
        c.organizationId,
        batch.map((moment, at) => ({
          id: momentVectorId(c.callId, c.epoch, c.repSeq, moment.index),
          vector: vectors[at] ?? [],
          attributes: {
            call_id: c.callId,
            epoch: c.epoch,
            rep_seq: c.repSeq,
            moment: moment.index,
            outcome: tag.outcome,
            outcome_seq: tag.outcomeSeq,
            // What a search shows, so a hit needs no Transcript read. Tenant text: never logged.
            prospect: attributeSnippet(prospectOf(moment)),
            rep_next: attributeSnippet(moment.repFollowing.join(' ')),
            // The attribute layout: search ignores vectors written before the snippets existed.
            v: MOMENT_VECTOR_VERSION,
          },
        }))
      )
      c.track?.(write)
      return write
    })
  }
}
