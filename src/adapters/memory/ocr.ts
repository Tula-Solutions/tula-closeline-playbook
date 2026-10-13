import type { OcrPage, OcrReader } from '~/ports/ocr'

/** One call the memory OCR reader received, for a test to assert on. */
export type OcrCall = { pages: readonly number[] }

/** An {@link OcrReader} in process memory that records its calls. */
export type MemoryOcrReader = OcrReader & { readonly calls: OcrCall[] }

/** Creates an OCR reader for tests and local runs; page `n` reads as `ocr text of page n`. */
export function createMemoryOcrReader(): MemoryOcrReader {
  const calls: OcrCall[] = []
  return {
    calls,
    recognise: async ({ pages }, { signal }) => {
      signal.throwIfAborted()
      calls.push({ pages: [...pages] })
      return pages.map((number): OcrPage => ({ number, text: `ocr text of page ${number}` }))
    },
  }
}

/**
 * Creates an OCR reader for runs where no real reader exists yet: every page reads as empty, so a
 * scanned document ends `no_text` instead of being filled with invented text.
 */
export function createEmptyOcrReader(): OcrReader {
  return {
    recognise: async ({ pages }, { signal }) => {
      signal.throwIfAborted()
      return pages.map((number): OcrPage => ({ number, text: '' }))
    },
  }
}
