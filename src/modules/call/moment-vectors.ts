import { PermanentFailure, type PipelineDeps, within } from '~/modules/ingestion/runtime'
import { MAX_EMBED_TEXTS } from '~/ports/embedder'
import { momentVectorId } from './keys'

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

/**
 * Embeds the Moments in batches of {@link MAX_EMBED_TEXTS} and writes each batch's vectors under
 * deterministic ids (`momentVectorId`), tagged with the Outcome and Outcome sequence given. Writing
 * the same build again overwrites, so it is safe to repeat; the tag is the only thing that differs
 * between a first build and a re-tag. A write that runs out of time may still land (the caller
 * decides what that means). Nothing here logs.
 */
export async function writeMomentVectors(
  c: MomentWriteContext,
  moments: readonly { index: number; text: string }[],
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
          },
        }))
      )
      c.track?.(write)
      return write
    })
  }
}
