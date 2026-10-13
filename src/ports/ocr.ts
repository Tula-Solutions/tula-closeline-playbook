import type { DocumentMediaType } from 'tula-closeline-contract'

/** One page that OCR read. */
export type OcrPage = {
  /** The page number in the document, from 1. */
  number: number
  /** The recognised text, which may be empty. */
  text: string
}

/** Options of one {@link OcrReader.recognise} call. */
export type OcrOptions = {
  /** Aborts the call; an adapter also bounds it with its own timeout. */
  signal: AbortSignal
}

/**
 * Reads pages with no text layer (ADR 0010: Mistral OCR 3), only the pages that need it. The
 * result is untrusted text like any other document text.
 */
export interface OcrReader {
  /** Recognises the listed pages (numbers from 1) of `bytes`; returns one entry per page asked for. */
  recognise(
    document: { bytes: Uint8Array; mediaType: DocumentMediaType; pages: readonly number[] },
    options: OcrOptions
  ): Promise<OcrPage[]>
}
