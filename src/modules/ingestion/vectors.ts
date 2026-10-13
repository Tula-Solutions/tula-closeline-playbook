import { z } from 'zod'
import { MAX_HEADING_CHARS } from './chunker'
import {
  chunksKey,
  documentPrefix,
  MAX_STALE_EPOCHS,
  type PipelineDeps,
  pagesKey,
  within,
} from './runtime'

/** The attributes every vector carries: what the cleanup deletes by and what a search shows. */
export type VectorMeta = { document_id: string; epoch: number; chunk: number; page: number }

/** The parsed pages kept between the parse step and the chunk step (a resume point); bounded by the settings. */
export function pagesArtifactSchema(env: Pick<PipelineDeps['env'], 'MAX_TEXT_CHARS_PER_DOCUMENT'>) {
  return z.strictObject({
    pages: z.array(
      z.strictObject({
        number: z.number().int().min(1),
        text: z.string().max(env.MAX_TEXT_CHARS_PER_DOCUMENT),
      })
    ),
  })
}

/** The chunks of one ingestion, kept in the object store: the text behind each vector, by chunk number; bounded by the settings. */
export function chunksArtifactSchema(
  env: Pick<PipelineDeps['env'], 'CHUNK_MAX_CHARS' | 'MAX_CHUNKS_PER_DOCUMENT'>
) {
  return z.strictObject({
    chunks: z
      .array(
        z.strictObject({
          index: z.number().int().min(0),
          page: z.number().int().min(1),
          pageEnd: z.number().int().min(1),
          heading: z.string().max(MAX_HEADING_CHARS),
          text: z.string().min(1).max(env.CHUNK_MAX_CHARS),
        })
      )
      .max(env.MAX_CHUNKS_PER_DOCUMENT),
  })
}

/**
 * Deletes a document's vectors tagged with an epoch up to and including `upToEpoch`, one filter per
 * epoch (the vector store's filters are equality only), the newest {@link MAX_STALE_EPOCHS} of them.
 * Idempotent. Never touches an epoch above `upToEpoch`, so the vectors a restore wrote survive.
 * Returns how many epochs it asked for, for tests and logs.
 */
export async function deleteVectorsUpTo(
  deps: PipelineDeps,
  organizationId: string,
  documentId: string,
  upToEpoch: number,
  signal: AbortSignal
): Promise<number> {
  const from = Math.max(0, upToEpoch - MAX_STALE_EPOCHS + 1)
  let calls = 0
  for (let epoch = from; epoch <= upToEpoch; epoch++) {
    await within(deps, 'vector store', deps.env.INGESTION_IO_TIMEOUT_MS, signal, () =>
      deps.vectors.deleteByFilter(organizationId, { document_id: documentId, epoch })
    )
    calls++
  }
  if (from > 0) {
    deps.logger.warn('older epochs of a document were left to the search-time state check', {
      organizationId,
      documentId,
      skippedBelow: from,
    })
  }
  return calls
}

/**
 * Deletes every vector of a document, whatever its epoch (the kit's filter matches every entry
 * given, so `{ document_id }` alone covers all epochs). Only for a purge, after the claim that
 * ends restores: a live cleanup must keep the vectors a restore wrote, and uses
 * {@link deleteVectorsUpTo}.
 */
export async function deleteAllVectorsOf(
  deps: PipelineDeps,
  organizationId: string,
  documentId: string,
  signal: AbortSignal
): Promise<void> {
  await within(deps, 'vector store', deps.env.INGESTION_IO_TIMEOUT_MS, signal, () =>
    deps.vectors.deleteByFilter(organizationId, { document_id: documentId })
  )
}

/** Deletes the pipeline's own objects of a document for epochs up to `upToEpoch` (best effort per object). */
export async function deleteArtifactsUpTo(
  deps: PipelineDeps,
  organizationId: string,
  documentId: string,
  upToEpoch: number,
  signal: AbortSignal
): Promise<void> {
  const from = Math.max(0, upToEpoch - MAX_STALE_EPOCHS + 1)
  for (let epoch = from; epoch <= upToEpoch; epoch++) {
    for (const key of [pagesKey(documentId, epoch), chunksKey(documentId, epoch)]) {
      await within(deps, 'object store', deps.env.INGESTION_IO_TIMEOUT_MS, signal, () =>
        deps.objects.delete(organizationId, key)
      )
    }
  }
}

/** Deletes every object under a document's prefix (the original, the pipeline's files), a bounded page at a time. */
export async function deleteDocumentObjects(
  deps: PipelineDeps,
  organizationId: string,
  documentId: string,
  signal: AbortSignal
): Promise<number> {
  let removed = 0
  // Each page is deleted before the next is listed, so the listing starts over from the top.
  for (let pages = 0; pages < 20; pages++) {
    const page = await within(deps, 'object store', deps.env.INGESTION_IO_TIMEOUT_MS, signal, () =>
      deps.objects.list(organizationId, { prefix: documentPrefix(documentId), limit: 100 })
    )
    for (const item of page.items) {
      await within(deps, 'object store', deps.env.INGESTION_IO_TIMEOUT_MS, signal, () =>
        deps.objects.delete(organizationId, item.key)
      )
      removed++
    }
    if (page.items.length === 0 || page.nextCursor === undefined) {
      break
    }
  }
  return removed
}
