import { MAX_TRANSCRIPT_BYTES } from 'tula-closeline-contract'
import { CALL_LIST, DEAL_LIST, DOCUMENT_LIST_FILTERED } from 'tula-closeline-db'
import { StorageError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { exportReplyRegistry } from '~/messages'
import { recordingTranscriptKey, repLabelOf } from '~/modules/call/keys'
import { buildMoments, capMoments } from '~/modules/call/moments'
import { toCall } from '~/modules/call/schema'
import { parseTranscript, type TranscriptMediaType } from '~/modules/call/transcript'
import { cursorPosition, toDeal } from '~/modules/deal/schema'
import { listRowSchema, toDocument } from '~/modules/document/schema'
import { originalKey } from '~/modules/ingestion/runtime'
import { PartWriter } from './part-writer'

/** What the export slice needs from the container. */
export type ExportDeps = Pick<
  Container,
  'scope' | 'objects' | 'exportQueue' | 'logger' | 'clock' | 'env'
>

/** The `export.requested` payload and the delivery facts the slice needs. */
export type ExportRequest = {
  organizationId: string
  exportId: string
  includeRecordingLinks: boolean
  traceId: string
  receiveCount: number
  signal: AbortSignal
  /** Rows per database page; {@link PAGE_SIZE} when left out (tests set it small to cross pages). */
  pageSize?: number
  /** The most files the part may hold; the contract's cap when left out (tests set it low). */
  maxFiles?: number
}

/** The rows one database page holds; the same for every dataset. */
const PAGE_SIZE = 100

/** The page size a request reads with. */
function pageOf(request: ExportRequest): number {
  return request.pageSize ?? PAGE_SIZE
}

/** The delivery after which a failure is reported to core instead of retried. */
export const LAST_ATTEMPT = 3

/** How long a Recording link works, in seconds: the object store's longest. */
export const RECORDING_LINK_SECONDS = 900

/** The most files one part may hold (the contract's cap). */
const MAX_PART_FILES = 10_000

/** The closed reasons a part reports for a failure. */
type FailureReason = 'write_failed' | 'storage_unavailable' | 'source_unavailable'

/** The object-store prefix of one export's Playbook part: the one core accepts. */
export function partPrefix(exportId: string): string {
  return `exports/${exportId}/playbook`
}

/** Rejects after `ms` when `fn` has not settled; the late result is dropped. */
async function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms)
  })
  const work = fn()
  work.catch(() => undefined)
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Throws when the message's work was cancelled (the consumer is stopping). */
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('aborted')
  }
}

/** Maps an error to the closed reason core is told; never carries the error's text. */
function reasonOf(error: unknown): FailureReason {
  if (error instanceof StorageError) {
    return error.code === 'storage.unavailable' ? 'storage_unavailable' : 'write_failed'
  }
  if (error instanceof PartTooLarge) {
    return 'write_failed'
  }
  return 'source_unavailable'
}

/** A part that would hold more files than core accepts. */
class PartTooLarge extends Error {}

/** Deletes every object under the part prefix, page by page, so a longer earlier attempt leaves nothing. */
async function clearPart(deps: ExportDeps, organizationId: string, prefix: string): Promise<void> {
  for (;;) {
    const page = await deps.objects.list(organizationId, { prefix: `${prefix}/`, limit: 1000 })
    for (const item of page.items) {
      await deps.objects.delete(organizationId, item.key)
    }
    if (page.items.length === 0 || page.nextCursor === undefined || page.nextCursor === null) {
      return
    }
  }
}

/** The key of the one object under `calls/<id>/original*`, or `undefined` when none is stored. */
async function callOriginalKey(
  deps: ExportDeps,
  organizationId: string,
  callId: string
): Promise<string | undefined> {
  const page = await deps.objects.list(organizationId, {
    prefix: `calls/${callId}/original`,
    limit: 10,
  })
  return page.items[0]?.key
}

/** Reads a stored Transcript within the size cap and the I/O timeout; `undefined` when absent, too big or unreadable. */
async function readTranscript(
  deps: ExportDeps,
  organizationId: string,
  key: string,
  mediaType: TranscriptMediaType
) {
  const info = await withTimeout(deps.env.INGESTION_IO_TIMEOUT_MS, () =>
    deps.objects.head(organizationId, key)
  )
  if (info === undefined || info.size > MAX_TRANSCRIPT_BYTES) {
    return undefined
  }
  const stored = await withTimeout(deps.env.INGESTION_IO_TIMEOUT_MS, () =>
    deps.objects.get(organizationId, key)
  )
  if (stored === undefined) {
    return undefined
  }
  const parsed = parseTranscript(stored.body, mediaType)
  return parsed.ok ? parsed.transcript : undefined
}

/** Writes the Documents: allow-listed metadata, and each original copied beside it. */
async function writeDocuments(
  deps: ExportDeps,
  request: ExportRequest,
  writer: PartWriter
): Promise<void> {
  const { organizationId } = request
  let at = 'infinity'
  let id = ''
  for (;;) {
    checkAbort(request.signal)
    const rows = await deps.scope(
      organizationId,
      async (run) =>
        (await run(DOCUMENT_LIST_FILTERED, [organizationId, at, id, pageOf(request), null])).rows
    )
    for (const row of rows) {
      checkAbort(request.signal)
      const document = toDocument(row)
      const detectedType = typeof row.detected_type === 'string' ? row.detected_type : null
      let file: string | null = null
      if (detectedType !== null) {
        const relative = `documents/${document.id}/original.${detectedType}`
        const copied = await writer.copy(
          originalKey(document.id, detectedType),
          relative,
          document.mediaType
        )
        file = copied ? relative : null
      }
      await writer.row('documents', { ...document, file })
    }
    const last = rows.at(-1)
    if (rows.length < pageOf(request) || last === undefined) {
      return
    }
    const position = listRowSchema.parse(last)
    at = position.created_at
    id = position.id
  }
}

/** Writes the Deals and their Outcomes. */
async function writeDeals(
  deps: ExportDeps,
  request: ExportRequest,
  writer: PartWriter
): Promise<void> {
  const { organizationId } = request
  let at = 'infinity'
  let id = ''
  for (;;) {
    checkAbort(request.signal)
    const rows = await deps.scope(
      organizationId,
      async (run) => (await run(DEAL_LIST, [organizationId, at, id, pageOf(request)])).rows
    )
    for (const row of rows) {
      const deal = toDeal(row)
      await writer.row('deals', deal)
      await writer.row('outcomes', {
        dealRecordId: deal.id,
        dealId: deal.dealId,
        outcome: deal.outcome,
        closedAt: deal.closedAt,
        amount: deal.amount,
        currency: deal.currency,
      })
    }
    const last = rows.at(-1)
    if (rows.length < pageOf(request) || last === undefined) {
      return
    }
    const position = cursorPosition(last)
    at = position.createdAt
    id = position.id
  }
}

/** Writes the Calls: Transcripts with turns, their Moments and, when asked, Recording links. */
async function writeCalls(
  deps: ExportDeps,
  request: ExportRequest,
  writer: PartWriter
): Promise<void> {
  const { organizationId } = request
  let at = 'infinity'
  let id = ''
  for (;;) {
    checkAbort(request.signal)
    const rows = await deps.scope(
      organizationId,
      async (run) => (await run(CALL_LIST, [organizationId, at, id, pageOf(request)])).rows
    )
    for (const row of rows) {
      checkAbort(request.signal)
      const call = toCall(row)
      const isRecording = call.kind === 'recording'
      let turns: { speaker: string; text: string }[] | null = null
      let speakers: string[] = []
      if (call.state === 'ready') {
        const key = isRecording
          ? recordingTranscriptKey(call.id)
          : await callOriginalKey(deps, organizationId, call.id)
        const transcript =
          key === undefined
            ? undefined
            : await readTranscript(
                deps,
                organizationId,
                key,
                isRecording ? 'application/json' : (call.mediaType as TranscriptMediaType)
              )
        if (transcript !== undefined) {
          turns = transcript.turns
          speakers = transcript.speakers
        }
      }
      await writer.row('transcripts', { ...call, speakers, turns })
      const repLabel = repLabelOf(row)
      if (turns !== null && repLabel !== null && speakers.includes(repLabel)) {
        const moments = capMoments(buildMoments(turns, repLabel), Number.MAX_SAFE_INTEGER)
        for (const moment of moments) {
          await writer.row('moments', {
            callId: call.id,
            index: moment.index,
            turn: moment.turn,
            text: moment.text,
            context: moment.context,
            repFollowing: moment.repFollowing,
          })
        }
      }
      if (request.includeRecordingLinks && isRecording) {
        const key = await callOriginalKey(deps, organizationId, call.id)
        if (key !== undefined) {
          const url = await deps.objects.presignGet(organizationId, key, {
            expiresInSeconds: RECORDING_LINK_SECONDS,
          })
          await writer.row('recordings', {
            callId: call.id,
            fileName: call.fileName,
            mediaType: call.mediaType,
            sizeBytes: call.sizeBytes,
            url,
            expiresAt: new Date(
              deps.clock.now().getTime() + RECORDING_LINK_SECONDS * 1000
            ).toISOString(),
          })
        }
      }
    }
    const last = rows.at(-1)
    if (rows.length < pageOf(request) || last === undefined) {
      return
    }
    const position = cursorPosition(last)
    at = position.createdAt
    id = position.id
  }
}

/** Publishes one reply to core's jobs queue. */
async function reply(
  deps: ExportDeps,
  request: ExportRequest,
  message:
    | { type: 'export.part_ready'; payload: Record<string, unknown> }
    | { type: 'export.part_failed'; payload: Record<string, unknown> }
): Promise<void> {
  await deps.exportQueue.publish(
    exportReplyRegistry.create({
      ...message,
      organizationId: request.organizationId,
      traceId: request.traceId,
    } as Parameters<typeof exportReplyRegistry.create>[0])
  )
}

/**
 * Writes the Playbook's slice of an Organization's export and tells core (spec M16, Export).
 *
 * Only the requesting Organization's data is read (every statement runs in its scope) and only
 * allow-listed fields are written: the public Document, Deal and Call shapes, never a key, hash
 * or token. Files are NDJSON under `exports/<id>/playbook/`, numbered per dataset, plus each
 * Document original; Recordings are links, never copies. Rows come from cursor pages of
 * {@link PAGE_SIZE} and leave in files of `EXPORT_ROWS_PER_FILE` rows, so memory does not grow
 * with the Organization. The part is cleared first and its keys are deterministic, so a
 * redelivery leaves the same objects. A failure is thrown back for a retry until
 * {@link LAST_ATTEMPT}, then reported as `export.part_failed` with a closed reason.
 */
export async function writeSlice(deps: ExportDeps, request: ExportRequest): Promise<void> {
  const prefix = partPrefix(request.exportId)
  let totals: { files: number; bytes: number }
  try {
    await clearPart(deps, request.organizationId, prefix)
    const writer = new PartWriter(
      deps,
      request.organizationId,
      prefix,
      deps.env.EXPORT_ROWS_PER_FILE,
      () => new PartTooLarge(),
      request.maxFiles ?? MAX_PART_FILES
    )
    await writeDocuments(deps, request, writer)
    await writeDeals(deps, request, writer)
    await writeCalls(deps, request, writer)
    totals = await writer.finish()
  } catch (error) {
    // A part over the cap fails the same way every time: report it at once, do not retry.
    // A shutdown abort is not the slice's fault: redeliver it to a live instance.
    if (request.signal.aborted) {
      throw error
    }
    if (request.receiveCount < LAST_ATTEMPT && !(error instanceof PartTooLarge)) {
      throw error
    }
    deps.logger.error('an export slice could not be written', {
      organizationId: request.organizationId,
      exportId: request.exportId,
      error: error instanceof Error ? error.name : 'unknown',
    })
    await reply(deps, request, {
      type: 'export.part_failed',
      payload: {
        exportId: request.exportId,
        service: 'playbook',
        reason: reasonOf(error),
        failedAt: deps.clock.now().toISOString(),
      },
    })
    return
  }
  // Outside the try: a failed publish is retried by the queue, never reported as a failed slice.
  await reply(deps, request, {
    type: 'export.part_ready',
    payload: {
      exportId: request.exportId,
      service: 'playbook',
      prefix,
      fileCount: totals.files,
      bytes: totals.bytes,
      readyAt: deps.clock.now().toISOString(),
    },
  })
}
