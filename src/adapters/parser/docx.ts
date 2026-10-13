import { type ParsedDocument, ParseError } from '~/ports/parser'
import type { ParserLimits } from './limits'
import { PageSink, splitFixed } from './pages'
import { scanXml, xmlAttribute } from './xml'
import { ZipArchive } from './zip'

/** The most `word/document.xml` may inflate to. */
const DOCUMENT_PART_MAX_BYTES = 32 * 1024 * 1024

/**
 * Parses a DOCX: only `word/document.xml` is read, as text; macros, embedded objects, relationships
 * and every other part are never opened. A word-processing file has no fixed pages, so a page ends
 * at an explicit page break, a rendered one (Word records where its layout broke) or
 * `pageBreakBefore`; a page longer than the fixed text page size is cut further. Headers, footers,
 * footnotes and deleted text are not part of the body and are left out.
 */
export function parseDocx(bytes: Uint8Array, limits: ParserLimits): ParsedDocument {
  const archive = new ZipArchive(bytes)
  if (!archive.has('word/document.xml')) {
    throw new ParseError('unreadable')
  }
  const xml = new TextDecoder('utf-8').decode(
    archive.read('word/document.xml', DOCUMENT_PART_MAX_BYTES)
  )
  const sink = new PageSink(limits)
  let page = ''
  let inText = false
  let skipping = 0
  const flush = () => {
    if (page.trim() !== '') {
      for (const piece of splitFixed(page)) {
        sink.push(piece)
      }
    }
    page = ''
  }
  const guard = () => {
    if (page.length > limits.maxTextChars) {
      throw new ParseError('processing_failed')
    }
  }
  scanXml(xml, {
    start(name, attributes) {
      if (name === 'Fallback') {
        // Alternate content repeats what its Choice branch already says.
        skipping++
      }
      if (skipping > 0) {
        return
      }
      if (name === 't') {
        inText = true
      } else if (name === 'tab') {
        page += '\t'
      } else if (name === 'br' || name === 'cr') {
        if (xmlAttribute(attributes, 'w:type') === 'page') {
          flush()
        } else {
          page += '\n'
        }
      } else if (name === 'lastRenderedPageBreak') {
        flush()
      } else if (name === 'pageBreakBefore') {
        const value = xmlAttribute(attributes, 'w:val')
        if (value !== '0' && value !== 'false') {
          flush()
        }
      }
    },
    end(name) {
      if (name === 'Fallback') {
        skipping--
      } else if (skipping === 0) {
        if (name === 't') {
          inText = false
        } else if (name === 'p') {
          page += '\n'
        }
      }
    },
    text(text) {
      if (inText && skipping === 0) {
        page += text
        guard()
      }
    },
  })
  flush()
  if (sink.count === 0) {
    sink.push('')
  }
  return { pages: sink.finish() }
}
