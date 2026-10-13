import type { DocumentMediaType } from 'tula-closeline-contract'
import { type ParsedDocument, ParseError } from '~/ports/parser'
import { parseDocx } from './docx'
import type { ParserLimits } from './limits'
import { parsePptx } from './pptx'
import { parseText } from './text'

/** The media type of a DOCX. */
export const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** The media type of a PPTX. */
export const PPTX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/**
 * Parses `bytes` of the given type in the calling thread. This is the work the worker does; call
 * it only from there (or from a test), because a hostile file can keep the thread busy.
 */
export async function extractDocument(
  bytes: Uint8Array,
  mediaType: DocumentMediaType,
  limits: ParserLimits
): Promise<ParsedDocument> {
  switch (mediaType) {
    case 'application/pdf': {
      // Loaded on first use: pdf.js is the largest part of the bundle and most documents are not PDFs.
      const { parsePdf } = await import('./pdf')
      return parsePdf(bytes, limits)
    }
    case DOCX_MEDIA_TYPE:
      return parseDocx(bytes, limits)
    case PPTX_MEDIA_TYPE:
      return parsePptx(bytes, limits)
    case 'text/plain':
    case 'text/markdown':
      return parseText(bytes, limits)
    default:
      throw new ParseError('unreadable')
  }
}
