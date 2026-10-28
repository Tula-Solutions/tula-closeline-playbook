/** Options of one {@link VoiceRecordings.open} call. */
export type VoiceRecordingOptions = {
  /** Aborts the call, over and above the adapter's own timeout. */
  signal: AbortSignal
}

/**
 * Voice's Recordings of ended Calls (ADR 0013), fetched over its internal route and never from
 * voice's bucket. The bytes are untrusted like any upload.
 */
export interface VoiceRecordings {
  /**
   * Opens the two-channel WAV of one ended Call of one Organization as a stream (channel 1 is the
   * Rep). `null` means voice has no such Recording (the Call or its file is gone). A Recording not
   * ready yet, a timeout or any other failure throws, so the queue redelivers. An adapter bounds
   * its own timeout and a jittered retry of the opening; the caller retries nothing itself.
   */
  open(
    organizationId: string,
    callId: string,
    options: VoiceRecordingOptions
  ): Promise<AsyncIterable<Uint8Array> | null>
}
