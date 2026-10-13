import type { DocumentMediaType } from 'tula-closeline-contract'
import { type ParsedDocument, ParseError, type ParseFailureReason } from '~/ports/parser'
import { extractDocument } from './extract'
import type { ParserLimits } from './limits'

/** What the host sends the worker: one document and the limits to parse it under. */
export type WorkerRequest = {
  bytes: Uint8Array
  mediaType: DocumentMediaType
  limits: ParserLimits
}

/** What the worker answers: the pages, or the reason it gave up (never a message, which could hold content). */
export type WorkerReply =
  | { ok: true; document: ParsedDocument }
  | { ok: false; reason: ParseFailureReason; pageCount: number | undefined }

declare const self: {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerReply): void
}

self.onmessage = async (event) => {
  const { bytes, mediaType, limits } = event.data
  let reply: WorkerReply
  try {
    reply = { ok: true, document: await extractDocument(bytes, mediaType, limits) }
  } catch (error) {
    reply =
      error instanceof ParseError
        ? { ok: false, reason: error.reason, pageCount: error.pageCount }
        : { ok: false, reason: 'processing_failed', pageCount: undefined }
  }
  self.postMessage(reply)
}
