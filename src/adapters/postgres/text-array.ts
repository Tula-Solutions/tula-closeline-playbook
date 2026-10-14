/**
 * A Postgres text-array literal (`{"a","b"}`) for a statement parameter cast with `::text[]`.
 * The statement helper binds a JavaScript array as a parenthesised list (`($1, $2)`), which
 * Postgres cannot cast to `text[]`, so an array parameter is sent as this one text value.
 */
export function toTextArrayLiteral(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}

/** Reads a literal made by {@link toTextArrayLiteral} (quoted elements only); `undefined` for any other text. */
export function parseTextArrayLiteral(literal: string): string[] | undefined {
  if (!literal.startsWith('{') || !literal.endsWith('}')) {
    return undefined
  }
  const body = literal.slice(1, -1)
  if (body === '') {
    return []
  }
  const items: string[] = []
  let index = 0
  while (index < body.length) {
    if (body[index] !== '"') {
      return undefined
    }
    let item = ''
    index++
    while (index < body.length && body[index] !== '"') {
      if (body[index] === '\\') {
        index++
      }
      item += body[index] ?? ''
      index++
    }
    if (body[index] !== '"') {
      return undefined
    }
    index++
    items.push(item)
    if (index < body.length) {
      if (body[index] !== ',') {
        return undefined
      }
      index++
    }
  }
  return items
}
