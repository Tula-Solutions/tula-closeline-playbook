/** Where a Call came from: an import, a Rep's own call, or an Agent's. */
export type CallOrigin = 'imported' | 'rep' | 'agent'

/**
 * The origin of a Call statement row. A row without the column (the db library before v0.51.0, so
 * every Call on a real database) reads as `imported`, so nothing is treated as Agent-origin by guess.
 */
export function callOriginOf(row: Record<string, unknown>): CallOrigin {
  return row.origin === 'agent' || row.origin === 'rep' ? row.origin : 'imported'
}
