import { describe, expect, test } from 'bun:test'
import { ParseError } from '~/ports/parser'
import { parsePdf } from './pdf'
import { buildPdf } from './test-support'

const limits = { maxPages: 300, maxTextChars: 5_000_000 }

/** The error a parse failed with, or `undefined`. */
async function failure(bytes: Uint8Array, use = limits): Promise<ParseError | undefined> {
  try {
    await parsePdf(bytes, use)
  } catch (error) {
    if (error instanceof ParseError) {
      return error
    }
    throw error
  }
  return undefined
}

describe('parsePdf', () => {
  test('each page is a page of its text, numbered from 1', async () => {
    const { pages } = await parsePdf(buildPdf({ pages: ['first page', 'second page'] }), limits)
    expect(pages.map((p) => [p.number, p.text.trim(), p.needsOcr])).toEqual([
      [1, 'first page', false],
      [2, 'second page', false],
    ])
  })

  test('a page with no text layer is empty and needs OCR; a file of only such pages still returns its pages', async () => {
    const { pages } = await parsePdf(buildPdf({ pages: ['has text', '', ''] }), limits)
    expect(pages.map((p) => p.needsOcr)).toEqual([false, true, true])
    const scanned = await parsePdf(buildPdf({ pages: ['', ''] }), limits)
    expect(scanned.pages.map((p) => p.text)).toEqual(['', ''])
  })

  test('text with PDF escapes and control characters comes out cleaned', async () => {
    const { pages } = await parsePdf(buildPdf({ pages: ['a (b) \\ c'] }), limits)
    expect(pages[0]?.text.trim()).toBe('a (b) \\ c')
  })

  test('a file that needs a password is password_protected', async () => {
    expect((await failure(buildPdf({ pages: ['x'], encrypted: true })))?.reason).toBe(
      'password_protected'
    )
  })

  test.each([
    ['text that is not a PDF', new TextEncoder().encode('just words, no pdf here')],
    ['an empty file', new Uint8Array()],
    ['a truncated PDF', buildPdf({ pages: ['x'] }).subarray(0, 60)],
  ])('%s is unreadable', async (_label, bytes) => {
    expect((await failure(bytes))?.reason).toBe('unreadable')
  })

  test('the page count is checked before any page is read', async () => {
    const pages = Array.from({ length: 400 }, () => 'x')
    const error = await failure(buildPdf({ pages }))
    expect(error?.reason).toBe('too_many_pages')
    expect(error?.pageCount).toBe(400)
  })

  test('a page tree that claims a billion pages is not trusted and does not stall', async () => {
    const started = performance.now()
    const error = await failure(buildPdf({ pages: ['x'], declaredCount: 1_000_000_000 }))
    expect(error === undefined || error.reason === 'too_many_pages').toBe(true)
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  test('more text than the limit stops the page being read and is processing_failed', async () => {
    const error = await failure(
      buildPdf({ pages: Array.from({ length: 3 }, () => 'word '.repeat(12)) }),
      {
        ...limits,
        maxTextChars: 100,
      }
    )
    expect(error?.reason).toBe('processing_failed')
  })

  test('a page tree nested ten thousand deep ends, as a document or as a failure, and quickly', async () => {
    const started = performance.now()
    const bytes = buildPdf({ pages: ['deep'], nestedDepth: 10_000 })
    let outcome: string
    try {
      await parsePdf(bytes, limits)
      outcome = 'parsed'
    } catch (error) {
      outcome = error instanceof ParseError ? error.reason : 'other'
    }
    expect(['parsed', 'unreadable', 'processing_failed']).toContain(outcome)
    expect(performance.now() - started).toBeLessThan(10_000)
  }, 20_000)

  test('300 pages parse', async () => {
    const pages = Array.from({ length: 300 }, (_v, i) => `page ${i + 1}`)
    const parsed = await parsePdf(buildPdf({ pages }), limits)
    expect(parsed.pages).toHaveLength(300)
    expect(parsed.pages[299]?.text.trim()).toBe('page 300')
  }, 20_000)
})
