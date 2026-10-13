import type { DocumentFailureReason, DocumentMediaType } from 'tula-closeline-contract'

/** One page of a parsed document. */
export type ParsedPage = {
  /** The page number, from 1. A text file is a single page. */
  number: number
  /** The text layer of the page; empty when the page has none. */
  text: string
  /** True when the page has no usable text layer and needs OCR (ADR 0010); the rule is the parser's. */
  needsOcr: boolean
}

/** What {@link DocumentParser.parse} returns. */
export type ParsedDocument = {
  pages: ParsedPage[]
}

/** The failure reasons a parser can name; the pipeline stores them as the document's `failureReason`. */
export type ParseFailureReason = Extract<DocumentFailureReason, 'unreadable' | 'password_protected'>

/** Thrown by a parser for a document it cannot read at all; the document ends `failed`. */
export class ParseError extends Error {
  readonly reason: ParseFailureReason

  /** Creates the error; `reason` is what the pipeline records, and the message never holds content. */
  constructor(reason: ParseFailureReason, options?: { cause?: unknown }) {
    super(`document could not be parsed: ${reason}`, options)
    this.name = 'ParseError'
    this.reason = reason
  }
}

/** Options of one {@link DocumentParser.parse} call. */
export type ParseOptions = {
  /** Aborts the call, over and above the adapter's own timeout. */
  signal: AbortSignal
}

/**
 * Extracts the text layer of a document inside this service (ADR 0010, ADR 0016). The file is
 * untrusted: a parser must not run anything in it and must bound the work it does on it. The page
 * count limit is checked by the ingestion job from the result, not here.
 */
export interface DocumentParser {
  /**
   * Parses `bytes` of the given media type, or throws a {@link ParseError}. Every call has its own timeout and a bounded, jittered retry inside the adapter (COMMON.md); the caller passes a signal to cancel it, and retries nothing itself.
   */
  parse(
    document: { bytes: Uint8Array; mediaType: DocumentMediaType },
    options: ParseOptions
  ): Promise<ParsedDocument>
}
