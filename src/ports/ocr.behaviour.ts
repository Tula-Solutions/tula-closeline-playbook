import { describe, expect, test } from 'bun:test'
import type { OcrReader } from './ocr'

/** The behaviour every {@link OcrReader} must show; run it against each adapter. */
export function ocrBehaviour(name: string, make: () => OcrReader): void {
  describe(`OcrReader behaviour: ${name}`, () => {
    test('returns one entry for each page asked for', async () => {
      const reader = make()

      const pages = await reader.recognise(
        { bytes: new Uint8Array([1]), mediaType: 'application/pdf', pages: [3, 7] },
        { signal: new AbortController().signal }
      )

      expect(pages.map((page) => page.number)).toEqual([3, 7])
    })

    test('an aborted signal rejects the call', async () => {
      const reader = make()
      const controller = new AbortController()
      controller.abort()

      await expect(
        reader.recognise(
          { bytes: new Uint8Array([1]), mediaType: 'application/pdf', pages: [1] },
          { signal: controller.signal }
        )
      ).rejects.toThrow()
    })
  })
}
