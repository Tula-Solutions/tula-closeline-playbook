import { describe, expect, test } from 'bun:test'
import { ParseError } from '~/ports/parser'
import { parserBehaviour } from '~/ports/parser.behaviour'
import { createMemoryParser, MEMORY_ENCRYPTED_MARKER } from './parser'

parserBehaviour('memory parser', () => ({
  parser: createMemoryParser(),
  readable: new TextEncoder().encode('hello\fworld'),
  unreadable: new Uint8Array([0xff, 0xfe, 0xfd]),
}))

const signal = new AbortController().signal
const encode = (text: string) => new TextEncoder().encode(text)

describe('memory parser specifics', () => {
  test('splits pages on form feeds and marks a page without text as needing OCR', async () => {
    const parsed = await createMemoryParser().parse(
      { bytes: encode('first\f \fthird'), mediaType: 'application/pdf' },
      { signal }
    )

    expect(parsed.pages).toEqual([
      { number: 1, text: 'first', needsOcr: false },
      { number: 2, text: ' ', needsOcr: true },
      { number: 3, text: 'third', needsOcr: false },
    ])
  })

  test('a document that starts with the encrypted marker is password protected', async () => {
    const error = await createMemoryParser()
      .parse(
        { bytes: encode(`${MEMORY_ENCRYPTED_MARKER} secret`), mediaType: 'application/pdf' },
        { signal }
      )
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ParseError)
    expect((error as ParseError).reason).toBe('password_protected')
  })
})
