import { momentSnippet } from 'tula-closeline-contract'

/** The vector store's limit on an attribute string, in UTF-16 units (kit's `MAX_ATTRIBUTE_STRING`). */
const MAX_ATTRIBUTE_UNITS = 512

/** What a cut snippet ends with, as in the contract's `excerptText`. */
const ELLIPSIS = '…'

/**
 * The contract snippet, cut again when it is longer than the vector store allows. The contract caps a
 * snippet at 512 code points, but the store counts UTF-16 units, and an emoji is two units, so a
 * snippet with emoji can overflow. Then it is cut as `excerptText` cuts: back to the last space, with
 * an ellipsis, in at most 512 units including the ellipsis, always at a code point boundary. A single
 * word longer than the room is cut hard (no space to cut at), still with the ellipsis.
 */
export function attributeSnippet(text: string): string {
  const snippet = momentSnippet(text)
  if (snippet.length <= MAX_ATTRIBUTE_UNITS) {
    return snippet
  }
  // An ellipsis the contract already added is replaced by ours.
  const body = Array.from(snippet.endsWith(ELLIPSIS) ? snippet.slice(0, -1) : snippet)
  const room = MAX_ATTRIBUTE_UNITS - ELLIPSIS.length
  let units = 0
  let fit = 0
  for (const point of body) {
    if (units + point.length > room) {
      break
    }
    units += point.length
    fit++
  }
  let end = fit
  if (body[fit] !== ' ') {
    const space = body.slice(0, fit).lastIndexOf(' ')
    end = space > 0 ? space : fit
  }
  return body.slice(0, end).join('').trimEnd() + ELLIPSIS
}
