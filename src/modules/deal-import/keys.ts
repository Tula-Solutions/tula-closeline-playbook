/** The key of an import's CSV in the object store: made from the import id, never the file name. */
export function importObjectKey(importId: string): string {
  return `deal-imports/${importId}/original.csv`
}

/** The id inside an object key `deal-imports/<id>/<file>`, or `undefined` for any other key. */
export function importIdOfKey(key: string): string | undefined {
  const match = /^deal-imports\/(dimp_[0-9a-f]{32})\/[^/]+$/.exec(key)
  return match?.[1]
}
