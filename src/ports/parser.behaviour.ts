import { describe, expect, test } from 'bun:test'
import { type DocumentParser, ParseError } from './parser'

/** What {@link parserBehaviour} needs from an adapter under test. */
export type ParserSubject = {
  parser: DocumentParser
  /** A small plain-text document the adapter can read. */
  readable: Uint8Array
  /** Bytes the adapter cannot read as any document. */
  unreadable: Uint8Array
}

/** The behaviour every {@link DocumentParser} must show; run it against each adapter. */
export function parserBehaviour(name: string, make: () => ParserSubject): void {
  describe(`DocumentParser behaviour: ${name}`, () => {
    test('a readable document has pages numbered from 1 without gaps', async () => {
      const { parser, readable } = make()

      const parsed = await parser.parse(
        { bytes: readable, mediaType: 'text/plain' },
        { signal: new AbortController().signal }
      )

      expect(parsed.pages.length).toBeGreaterThan(0)
      expect(parsed.pages.map((page) => page.number)).toEqual(
        parsed.pages.map((_page, index) => index + 1)
      )
    })

    test('a document it cannot read is a ParseError with a stored reason', async () => {
      const { parser, unreadable } = make()

      const error = await parser
        .parse(
          { bytes: unreadable, mediaType: 'application/pdf' },
          { signal: new AbortController().signal }
        )
        .catch((thrown: unknown) => thrown)

      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).reason).toBe('unreadable')
    })

    test('an aborted signal rejects the call', async () => {
      const { parser, readable } = make()
      const controller = new AbortController()
      controller.abort()

      await expect(
        parser.parse({ bytes: readable, mediaType: 'text/plain' }, { signal: controller.signal })
      ).rejects.toThrow()
    })
  })
}
