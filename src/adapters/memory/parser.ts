import { type DocumentParser, type ParsedPage, ParseError } from '~/ports/parser'

/** The bytes a memory-parsed document starts with to behave as a password-protected one. */
export const MEMORY_ENCRYPTED_MARKER = '%ENCRYPTED%'

/** The character that ends a page in a memory-parsed document (a form feed, as in plain text). */
export const MEMORY_PAGE_BREAK = '\f'

/**
 * Creates a parser for tests and local runs that reads every document as UTF-8 text. Form feeds
 * split pages; a page with no text needs OCR; bytes that are not UTF-8 are `unreadable`; a document
 * starting with {@link MEMORY_ENCRYPTED_MARKER} is `password_protected`.
 */
export function createMemoryParser(): DocumentParser {
  return {
    parse: async ({ bytes }, { signal }) => {
      signal.throwIfAborted()
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (cause) {
        throw new ParseError('unreadable', { cause })
      }
      if (text.startsWith(MEMORY_ENCRYPTED_MARKER)) {
        throw new ParseError('password_protected')
      }
      const pages = text.split(MEMORY_PAGE_BREAK).map(
        (page, index): ParsedPage => ({
          number: index + 1,
          text: page,
          needsOcr: page.trim() === '',
        })
      )
      return { pages }
    },
  }
}
