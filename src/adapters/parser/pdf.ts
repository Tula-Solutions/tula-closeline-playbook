import { getDocumentProxy } from 'unpdf'
import { type ParsedDocument, ParseError } from '~/ports/parser'
import type { ParserLimits } from './limits'
import { PageSink } from './pages'

/** The longest one page may take to load and read, in ms; a page that takes longer fails the document. */
export const PDF_PAGE_TIMEOUT_MS = 20_000

/** Rejects with `processing_failed` when `work` outlasts the page deadline. */
async function withinPage<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ParseError('processing_failed')), PDF_PAGE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Whether `error` is pdf.js asking for a password. */
function needsPassword(error: unknown): boolean {
  return error instanceof Error && error.name === 'PasswordException'
}

/**
 * Parses a PDF with pdf.js (through unpdf, which bundles a build for server runtimes and needs no
 * native canvas). pdf.js 6 has no `eval` path; no font is loaded from the system,
 * no XFA form runs and no scripting is available; a file that asks for a password is
 * `password_protected`. The page count the file declares is checked against the limit before any
 * page is read, and each page is read as a stream whose text is kept only up to the document's text budget. A page with no text layer is returned empty and marked `needsOcr`.
 */
export async function parsePdf(bytes: Uint8Array, limits: ParserLimits): Promise<ParsedDocument> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // pdf.js takes ownership of the buffer it is given, so it gets a copy.
    pdf = await getDocumentProxy(bytes.slice(), {
      verbosity: 0,
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
      maxImageSize: 1,
    })
  } catch (cause) {
    throw new ParseError(needsPassword(cause) ? 'password_protected' : 'unreadable', { cause })
  }
  try {
    const count = pdf.numPages
    if (!Number.isInteger(count) || count < 1) {
      throw new ParseError('unreadable')
    }
    if (count > limits.maxPages) {
      throw new ParseError('too_many_pages', { pageCount: count })
    }
    const sink = new PageSink(limits)
    for (let number = 1; number <= count; number++) {
      sink.push(...(await withinPage(readPage(pdf, number, sink.remaining))))
    }
    return { pages: sink.finish() }
  } catch (error) {
    if (error instanceof ParseError) {
      throw error
    }
    throw new ParseError(needsPassword(error) ? 'password_protected' : 'unreadable', {
      cause: error,
    })
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined)
  }
}

/** The text of one page and whether it has none, read as a stream of at most `budget` characters. */
async function readPage(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  number: number,
  budget: number
): Promise<[text: string, needsOcr: boolean]> {
  const page = await pdf.getPage(number)
  const reader = page.streamTextContent().getReader()
  const parts: string[] = []
  let chars = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      for (const item of value.items) {
        // Past the budget nothing more is kept (the document is over its limit), but the stream is
        // read to its end: pdf.js raises an error of its own when a reader cancels it midway.
        if ('str' in item && chars <= budget) {
          parts.push(item.hasEOL ? `${item.str}\n` : item.str)
          chars += item.str.length + 1
        }
      }
    }
  } finally {
    reader.releaseLock()
    page.cleanup()
  }
  if (chars > budget) {
    // The stream was cut at the document's text budget: the document is over its limit.
    throw new ParseError('processing_failed')
  }
  const text = parts.join('')
  return [text, text.trim() === '']
}
