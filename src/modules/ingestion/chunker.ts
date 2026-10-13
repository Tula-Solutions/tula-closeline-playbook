/*
 * The chunker (ADR 0016: "split on headings and paragraphs with the page kept"). Pure: text in,
 * chunks out, no port, no clock, no randomness, so a re-run of a resumed job cuts the same chunks
 * and the same vector ids.
 *
 * What it does, in order, in one pass over the text (O(total characters), memory O(input + output)):
 *
 * 1. Cleans each page: control characters, bidirectional overrides, zero-width marks and lone
 *    surrogates are removed or replaced, line ends become `\n`. Page text is untrusted data: it is
 *    only ever cut and copied, never interpreted.
 * 2. Splits each page into paragraphs (blank-line separated) and spots headings: a Markdown `#`
 *    line, an all-capitals line, or a numbered line such as `2.1 Pricing`, each short and without a
 *    closing full stop. A heading closes the chunk before it and opens the next.
 * 3. Packs paragraphs into chunks towards `targetChars`, never above `maxChars`. A paragraph that is
 *    longer than `maxChars` is cut at sentence ends, and a sentence longer than that is cut at the
 *    last space before the limit (or exactly at the limit when there is none). Only the pieces of
 *    one over-long paragraph overlap, by `overlapChars` snapped to a word start, so a thought cut
 *    in two is still whole in one of them.
 * 4. Never emits a chunk that is empty after trimming.
 *
 * Each chunk keeps the page it starts on (`page`), the page it ends on (`pageEnd`) and the heading
 * it sits under.
 */

/** One page of text to chunk; numbers need not be contiguous. */
export type ChunkInputPage = {
  /** The page number, from 1. */
  number: number
  /** The page's text, untrusted. */
  text: string
}

/** How big chunks are; the service reads these from its settings. */
export type ChunkOptions = {
  /** The size a chunk is packed towards, in characters. */
  targetChars: number
  /** The size no chunk exceeds, in characters. Must be at least `targetChars + overlapChars`. */
  maxChars: number
  /** How much of the previous piece an over-long paragraph's next piece repeats, in characters. */
  overlapChars: number
  /** The most chunks to produce; one more throws {@link ChunkLimitError}. */
  maxChunks: number
}

/** One chunk of a document. */
export type Chunk = {
  /** The position in the document, from 0 and without gaps. */
  index: number
  /** The page the chunk starts on. */
  page: number
  /** The page the chunk ends on; equals `page` for a chunk inside one page. */
  pageEnd: number
  /** The heading the chunk sits under, cut to {@link MAX_HEADING_CHARS}; empty when there is none. */
  heading: string
  /** The chunk's text: non-empty, trimmed, at most `maxChars` characters. */
  text: string
}

/** Thrown by {@link chunkPages} when the document would give more than `maxChunks` chunks. */
export class ChunkLimitError extends Error {
  /** Creates the error; it carries the limit, never any text. */
  constructor(readonly limit: number) {
    super(`a document may give at most ${limit} chunks`)
    this.name = 'ChunkLimitError'
  }
}

/** The longest heading kept on a chunk, in characters. */
export const MAX_HEADING_CHARS = 200

/** The longest line, in characters, that can be a heading. */
const MAX_HEADING_LINE = 100

// Control characters (the tab and line feed are kept), bidirectional overrides and isolates, zero
// width space and direction marks, the word joiner and the byte order mark.
const REMOVED_RANGES = [
  '\\u0000-\\u0008',
  '\\u000E-\\u001F',
  '\\u007F-\\u009F',
  '\\u200B',
  '\\u200E\\u200F',
  '\\u202A-\\u202E',
  '\\u2060',
  '\\u2066-\\u2069',
  '\\uFEFF',
]
const REMOVED = new RegExp(`[${REMOVED_RANGES.join('')}]`, 'g')
const LINE_BREAKS = new RegExp(
  `\\r\\n|[${['\\r', '\\u000B', '\\u000C', '\\u0085', '\\u2028', '\\u2029'].join('')}]`,
  'g'
)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Cleans untrusted text for chunking: line ends to `\n`, control characters, direction overrides
 * and lone surrogates gone. Linear in the text.
 */
export function cleanText(text: string): string {
  return text.replace(LINE_BREAKS, '\n').replace(REMOVED, '').replace(LONE_SURROGATE, '�')
}

const MARKDOWN_HEADING = /^#{1,6}[ \t]+(\S.*)$/
const NUMBERED_HEADING = /^(?:\d{1,3}(?:\.\d{1,3}){0,4}|[IVXLC]{1,6})[.)]?[ \t]+\p{Lu}/u

/** Whether `line` ends like a sentence, which a heading does not. */
function endsLikeSentence(line: string): boolean {
  return /[.,;:!?]$/.test(line)
}

/** The heading text of a one-line paragraph, or `undefined` when it is not a heading. */
function headingOf(line: string): string | undefined {
  const markdown = MARKDOWN_HEADING.exec(line)
  if (markdown?.[1] !== undefined) {
    return markdown[1].replace(/[ \t]+#+$/, '').trim()
  }
  if (line.length > MAX_HEADING_LINE || endsLikeSentence(line)) {
    return undefined
  }
  const letters = line.replace(/[^\p{L}]/gu, '')
  if (
    letters.length >= 3 &&
    letters === letters.toUpperCase() &&
    letters !== letters.toLowerCase()
  ) {
    return line
  }
  if (NUMBERED_HEADING.test(line)) {
    return line
  }
  return undefined
}

/** One paragraph, or one heading, with the page it is on. */
type Block = { page: number; text: string; heading: boolean }

/** Splits a cleaned page into blocks: paragraphs on blank lines, a one-line paragraph that reads as a heading flagged. */
function* blocksOf(page: number, cleaned: string): Generator<Block> {
  let lines: string[] = []
  const flush = function* (): Generator<Block> {
    if (lines.length > 0) {
      const text = lines.join('\n')
      lines = []
      const single = text.split('\n').length === 1 ? headingOf(text) : undefined
      yield single === undefined
        ? { page, text, heading: false }
        : { page, text: single, heading: true }
    }
  }
  for (const raw of cleaned.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      yield* flush()
    } else {
      lines.push(line)
    }
  }
  yield* flush()
}

/** Cuts `text` at the last whitespace before `limit` (or at `limit`), without splitting a surrogate pair. */
function hardCut(text: string, from: number, limit: number): number {
  const end = Math.min(from + limit, text.length)
  if (end === text.length) {
    return end
  }
  for (let at = end; at > from + limit * 0.6; at--) {
    const code = text.charCodeAt(at)
    if (code === 32 || code === 10 || code === 9) {
      return at
    }
  }
  const last = text.charCodeAt(end - 1)
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end
}

/**
 * Where the sentence that starts at `from` ends, looking at most `limit` characters ahead: just
 * after the first `.`, `!` or `?` followed by whitespace, or the end of the text. -1 when there is
 * none within the limit, so the scan of a text with no sentence end stays linear.
 */
function sentenceEnd(text: string, from: number, limit: number): number {
  const stop = Math.min(from + limit, text.length)
  for (let at = from; at < stop; at++) {
    const code = text.charCodeAt(at)
    if ((code === 46 || code === 33 || code === 63) && at + 1 >= text.length) {
      return text.length
    }
    if (code === 46 || code === 33 || code === 63) {
      const next = text.charCodeAt(at + 1)
      if (next === 32 || next === 10 || next === 9) {
        return at + 1
      }
    }
  }
  return stop >= text.length ? text.length : -1
}

/** The start of the last `overlap` characters of `piece`, moved forward to a word start. */
function overlapOf(piece: string, overlap: number): string {
  if (overlap <= 0 || piece.length <= overlap) {
    return ''
  }
  let start = piece.length - overlap
  while (start < piece.length) {
    const code = piece.charCodeAt(start - 1)
    if (code === 32 || code === 10 || code === 9) {
      break
    }
    start++
  }
  return start >= piece.length ? '' : piece.slice(start)
}

/**
 * Cuts one paragraph longer than `maxChars` into pieces of at most `maxChars`: sentences packed
 * towards `targetChars`, a sentence longer than the room left cut hard, each piece after the first
 * beginning with the tail of the one before.
 */
function splitLong(text: string, options: ChunkOptions): string[] {
  const { targetChars, maxChars, overlapChars } = options
  // A sentence plus the overlap and one space must still fit the limit.
  const sentenceLimit = maxChars - overlapChars - 1
  const pieces: string[] = []
  let current = ''
  let at = 0
  while (at < text.length) {
    while (at < text.length && /\s/.test(text.charAt(at))) {
      at++
    }
    if (at >= text.length) {
      break
    }
    let end = sentenceEnd(text, at, sentenceLimit)
    if (end < 0) {
      end = hardCut(text, at, sentenceLimit)
    }
    const sentence = text.slice(at, end).trim()
    at = end
    if (sentence === '') {
      continue
    }
    if (current !== '' && current.length + 1 + sentence.length > targetChars) {
      pieces.push(current)
      const tail = overlapOf(current, overlapChars)
      current = tail === '' ? sentence : `${tail} ${sentence}`
    } else {
      current = current === '' ? sentence : `${current} ${sentence}`
    }
  }
  if (current.trim() !== '') {
    pieces.push(current.trim())
  }
  return pieces
}

/**
 * Cuts pages into chunks. Deterministic: the same pages and options always give the same chunks.
 * Throws {@link ChunkLimitError} as soon as chunk number `maxChunks + 1` would be produced, so a
 * hostile document costs bounded work.
 */
export function chunkPages(pages: readonly ChunkInputPage[], options: ChunkOptions): Chunk[] {
  const { targetChars, maxChars, maxChunks } = options
  const minChars = Math.floor(targetChars / 4)
  const chunks: Chunk[] = []
  let heading = ''
  let parts: string[] = []
  let size = 0
  let startPage = 0
  let endPage = 0

  const emit = (text: string, page: number, pageEnd: number): void => {
    const trimmed = text.trim()
    if (trimmed === '') {
      return
    }
    if (chunks.length >= maxChunks) {
      throw new ChunkLimitError(maxChunks)
    }
    chunks.push({ index: chunks.length, page, pageEnd, heading, text: trimmed })
  }
  const flush = (): void => {
    if (parts.length > 0) {
      emit(parts.join('\n\n'), startPage, endPage)
    }
    parts = []
    size = 0
  }

  for (const page of pages) {
    for (const block of blocksOf(page.number, cleanText(page.text))) {
      if (block.heading) {
        flush()
        heading = block.text.slice(0, MAX_HEADING_CHARS)
        parts = [block.text]
        size = block.text.length
        startPage = endPage = block.page
        continue
      }
      if (block.text.length > maxChars) {
        const pieces = splitLong(block.text, options)
        const lead = parts.join('\n\n')
        // A heading waiting alone goes in front of the first piece when they fit together.
        const first = pieces[0] ?? ''
        const joinsLead =
          parts.length > 0 && size < minChars && lead.length + 2 + first.length <= maxChars
        if (joinsLead) {
          pieces[0] = `${lead}\n\n${first}`
          emit(pieces[0], startPage, block.page)
          parts = []
          size = 0
        } else {
          flush()
          emit(first, block.page, block.page)
        }
        for (const piece of pieces.slice(1)) {
          emit(piece, block.page, block.page)
        }
        continue
      }
      const combined = size + (parts.length > 0 ? 2 : 0) + block.text.length
      const fits = combined <= targetChars || (size < minChars && combined <= maxChars)
      if (parts.length > 0 && !fits) {
        flush()
      }
      if (parts.length === 0) {
        startPage = block.page
        size = block.text.length
      } else {
        size = combined
      }
      parts.push(block.text)
      endPage = block.page
    }
  }
  flush()
  return chunks
}
