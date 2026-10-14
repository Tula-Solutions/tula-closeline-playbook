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

/** The object key of the Transcript kept from a Recording: JSON turns, under the Call's prefix so the purge removes it. */
export function recordingTranscriptKey(callId: string): string {
  return `${callPrefix(callId)}transcript.json`
}

/** The client reference of send `seq` of a Call at the transcription vendor: `<call id>:<seq>`. */
export function clientReferenceOf(callId: string, seq: number): string {
  return `${callId}:${seq}`
}

/** The prefix that matches every client reference of one Call (it ends with the separator, so `call_1:` never matches `call_10:`). */
export function clientReferencePrefix(callId: string): string {
  return `${callId}:`
}

/** The send number inside a client reference made by {@link clientReferenceOf} for this Call, or `undefined` for any other text. */
export function sendOfReference(callId: string, reference: string): number | undefined {
  if (!reference.startsWith(clientReferencePrefix(callId))) {
    return undefined
  }
  const tail = reference.slice(clientReferencePrefix(callId).length)
  return /^[1-9][0-9]{0,2}$/.test(tail) ? Number(tail) : undefined
}

/**
 * The label the Rep's turns carry in a Call's kept Transcript: a speaker label as chosen, or the
 * channel's name (`left` or `right`, the labels a per-side Recording's turns get), or `null` while
 * no Rep is chosen.
 */
export function repLabelOf(call: {
  rep_by?: unknown
  rep_label?: unknown
  rep_channel?: unknown
}): string | null {
  if (call.rep_by === 'speaker' && typeof call.rep_label === 'string') {
    return call.rep_label
  }
  if (call.rep_by === 'channel' && typeof call.rep_channel === 'string') {
    return call.rep_channel
  }
  return null
}
