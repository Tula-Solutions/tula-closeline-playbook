import { type ParsedDocument, ParseError } from '~/ports/parser'
import { MAX_REPLACEMENT_RATIO, type ParserLimits } from './limits'
import { PageSink, splitFixed } from './pages'

/**
 * Parses a plain-text or Markdown file. The rule: a UTF-8 byte order mark is dropped; a UTF-16
 * byte order mark or any NUL byte means the file is not text (`unreadable`); other invalid UTF-8
 * becomes U+FFFD, and more than one in a hundred characters doing so is `unreadable` too. More
 * text than the limit is `processing_failed`. Pages are cut by a fixed character size
 * ({@link splitFixed}), since text has none.
 */
export function parseText(bytes: Uint8Array, limits: ParserLimits): ParsedDocument {
  const first = bytes[0]
  const second = bytes[1]
  if ((first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff)) {
    throw new ParseError('unreadable')
  }
  const start = first === 0xef && second === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const body = bytes.subarray(start)
  if (body.indexOf(0) !== -1) {
    throw new ParseError('unreadable')
  }
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(body)
  if (text.length > limits.maxTextChars) {
    throw new ParseError('processing_failed')
  }
  const allowed = Math.max(8, Math.floor(text.length * MAX_REPLACEMENT_RATIO))
  let replaced = 0
  for (let at = text.indexOf('�'); at !== -1; at = text.indexOf('�', at + 1)) {
    if (++replaced > allowed) {
      throw new ParseError('unreadable')
    }
  }
  const sink = new PageSink(limits)
  for (const piece of splitFixed(text)) {
    sink.push(piece)
  }
  return { pages: sink.finish() }
}
