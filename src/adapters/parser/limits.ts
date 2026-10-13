/** What a parse may keep; the pipeline's own limits, handed to the parser so it can stop early. */
export type ParserLimits = {
  /** The most pages one document may have (`MAX_PAGES_PER_DOCUMENT`). */
  maxPages: number
  /** The most characters of text one document may hold after cleaning (`MAX_TEXT_CHARS_PER_DOCUMENT`). */
  maxTextChars: number
}

/** The characters of one page of a plain-text, Markdown or unbroken word-processing document, which have no pages of their own. */
export const TEXT_PAGE_CHARS = 20_000

/** The share of a text file's characters that may be replacement characters before it counts as not text. */
export const MAX_REPLACEMENT_RATIO = 0.01
