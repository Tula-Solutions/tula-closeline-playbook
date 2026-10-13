import { cleanText } from '~/modules/ingestion/chunker'
import { type ParsedPage, ParseError } from '~/ports/parser'
import { type ParserLimits, TEXT_PAGE_CHARS } from './limits'

/**
 * Cuts `text` into pieces of at most `size` characters. A cut falls after a line end when one lies
 * in the last tenth of the piece, and never between the halves of a surrogate pair. Linear.
 */
export function splitFixed(text: string, size: number = TEXT_PAGE_CHARS): string[] {
  const pieces: string[] = []
  let from = 0
  while (text.length - from > size) {
    let to = from + size
    const lineEnd = text.lastIndexOf('\n', to - 1)
    if (lineEnd >= to - Math.floor(size / 10)) {
      to = lineEnd + 1
    } else if (isHighSurrogate(text.charCodeAt(to - 1))) {
      to -= 1
    }
    pieces.push(text.slice(from, to))
    from = to
  }
  pieces.push(text.slice(from))
  return pieces
}

/** Whether `code` is the first half of a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** Collects the pages of one parse and enforces the page and text limits as they arrive. */
export class PageSink {
  private readonly pages: ParsedPage[] = []
  private chars = 0

  /** Creates a sink under `limits`. */
  constructor(private readonly limits: ParserLimits) {}

  /** The pages so far. */
  get count(): number {
    return this.pages.length
  }

  /** Adds one page of untrusted text, cleaned the way the chunker expects; over a limit it throws a {@link ParseError}. */
  push(text: string, needsOcr = false): void {
    if (this.pages.length >= this.limits.maxPages) {
      throw new ParseError('too_many_pages', { pageCount: this.pages.length + 1 })
    }
    const clean = cleanText(text)
    this.chars += clean.length
    if (this.chars > this.limits.maxTextChars) {
      throw new ParseError('processing_failed')
    }
    this.pages.push({ number: this.pages.length + 1, text: clean, needsOcr })
  }

  /** The finished pages. */
  finish(): ParsedPage[] {
    return this.pages
  }
}
