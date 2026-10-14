/** The object key of a Call's original file: `calls/<id>/original<ext>`, the extension as the contract lists it (`.txt`, `.vtt`, `.srt`, `.json`). */
export function callObjectKey(callId: string, extension: string): string {
  return `calls/${callId}/original${extension}`
}

/** The prefix under which every object of one Call lives. */
export function callPrefix(callId: string): string {
  return `calls/${callId}/`
}

/** The id inside an object key `calls/<id>/<file>`, or `undefined` for any other key. */
export function callIdOfKey(key: string): string | undefined {
  const match = /^calls\/(call_[0-9a-f]{32})\/[^/]+$/.exec(key)
  return match?.[1]
}

/**
 * The vector id of a Moment: the Call's 32 hex digits, the epoch, the Rep sequence and the Moment
 * number. Deterministic, so a resumed job overwrites instead of duplicating, and the epoch and Rep
 * sequence keep a restore's and a Rep change's vectors apart from the earlier ones. At most
 * 32 + 3 separators + 10 + 10 + 5 = 60 characters, under the store's 64.
 */
export function momentVectorId(
  callId: string,
  epoch: number,
  repSeq: number,
  moment: number
): string {
  return `${callId.slice('call_'.length)}:${epoch}:${repSeq}:${moment}`
}
