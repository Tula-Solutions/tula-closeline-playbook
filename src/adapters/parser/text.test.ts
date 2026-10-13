import { describe, expect, test } from 'bun:test'
import { ParseError } from '~/ports/parser'
import { TEXT_PAGE_CHARS } from './limits'
import { splitFixed } from './pages'
import { parseText } from './text'

const limits = { maxPages: 300, maxTextChars: 5_000_000 }
const bytes = (text: string) => new TextEncoder().encode(text)
const failure = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    return error instanceof ParseError ? error.reason : 'other'
  }
  return undefined
}

describe('parseText', () => {
  test('a short file is one page of its text', () => {
    expect(parseText(bytes('hello\nworld'), limits).pages).toEqual([
      { number: 1, text: 'hello\nworld', needsOcr: false },
    ])
  })

  test('a UTF-8 byte order mark is dropped, other text is kept as is', () => {
    const pages = parseText(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('é ok')]), limits).pages
    expect(pages[0]?.text).toBe('é ok')
  })

  test('UTF-16 text and NUL bytes are not text', () => {
    expect(failure(() => parseText(new Uint8Array([0xff, 0xfe, 0x61, 0]), limits))).toBe(
      'unreadable'
    )
    expect(failure(() => parseText(new Uint8Array([0xfe, 0xff, 0, 0x61]), limits))).toBe(
      'unreadable'
    )
    expect(failure(() => parseText(bytes('abc\u0000def'), limits))).toBe('unreadable')
  })

  test('a few invalid bytes become U+FFFD; mostly invalid bytes are unreadable', () => {
    const some = new Uint8Array([...bytes('a'.repeat(500)), 0xff, ...bytes('b'.repeat(500))])
    expect(parseText(some, limits).pages[0]?.text).toContain('�')
    const garbage = new Uint8Array(1000).fill(0xff)
    expect(failure(() => parseText(garbage, limits))).toBe('unreadable')
  })

  test('control characters are removed from the page', () => {
    expect(parseText(bytes('a\u0001b‮c\r\nd'), limits).pages[0]?.text).toBe('abc\nd')
  })

  test('long text is cut by a fixed size, after a line end when one is near', () => {
    const line = `${'x'.repeat(99)}\n`
    const text = line.repeat(500)
    const pages = parseText(bytes(text), limits).pages
    expect(pages.map((p) => p.number)).toEqual(pages.map((_p, i) => i + 1))
    expect(pages.length).toBe(Math.ceil(text.length / TEXT_PAGE_CHARS))
    expect(pages.every((p) => p.text.length <= TEXT_PAGE_CHARS)).toBe(true)
    expect(pages.map((p) => p.text).join('')).toBe(text)
    expect(pages[0]?.text.endsWith('\n')).toBe(true)
  })

  test('a cut never splits a surrogate pair', () => {
    const text = `${'a'.repeat(TEXT_PAGE_CHARS - 1)}😀${'b'.repeat(10)}`
    const [first, second] = splitFixed(text)
    expect(first?.length).toBe(TEXT_PAGE_CHARS - 1)
    expect(second?.startsWith('😀')).toBe(true)
  })

  test('more text than the limit is processing_failed; more pages than the limit is too_many_pages', () => {
    expect(
      failure(() => parseText(bytes('a'.repeat(1001)), { ...limits, maxTextChars: 1000 }))
    ).toBe('processing_failed')
    const long = bytes('a'.repeat(TEXT_PAGE_CHARS * 3))
    expect(failure(() => parseText(long, { ...limits, maxPages: 2 }))).toBe('too_many_pages')
  })

  test('a 25 MB text file is refused by the text limit without building pages', () => {
    const big = bytes('word '.repeat(5_300_000))
    expect(big.length).toBeGreaterThan(25 * 1024 * 1024)
    expect(failure(() => parseText(big, limits))).toBe('processing_failed')
  })

  test('an empty file is one empty page, which the pipeline ends as no_text', () => {
    expect(parseText(new Uint8Array(), limits).pages).toEqual([
      { number: 1, text: '', needsOcr: false },
    ])
  })
})
