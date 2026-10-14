import { momentSnippet } from 'tula-closeline-contract'

/** The vector store's limit on an attribute string, in UTF-16 units (kit's `MAX_ATTRIBUTE_STRING`). */
const MAX_ATTRIBUTE_UNITS = 512

/** A snippet cut to at most {@link MAX_ATTRIBUTE_UNITS} UTF-16 units at a code point boundary, then re-trimmed: an emoji is two units but one code point, so the contract's cap alone can overflow the store's. */
export function attributeSnippet(text: string): string {
  const snippet = momentSnippet(text)
  if (snippet.length <= MAX_ATTRIBUTE_UNITS) {
    return snippet
  }
  let end = 0
  for (const point of snippet) {
    if (end + point.length > MAX_ATTRIBUTE_UNITS) {
      break
    }
    end += point.length
  }
  return snippet.slice(0, end).trimEnd()
}
