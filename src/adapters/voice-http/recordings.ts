import { ERRORS } from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { VoiceRecordings } from '~/ports/voice-recordings'

/** The longest one attempt may take, headers and body together, in milliseconds. */
export const VOICE_RECORDING_TIMEOUT_MS = 120_000
/** Retries of the opening after a timeout, a network error or a 503, on top of the first attempt. */
export const VOICE_RECORDING_RETRIES = 2
/** The base of the exponential backoff between attempts, in milliseconds. */
const BACKOFF_BASE_MS = 200

/** Options for {@link createVoiceHttpRecordings}. */
export type VoiceHttpOptions = {
  /** Voice's origin, for example `https://voice.internal`. */
  baseUrl: string
  /** The internal bearer secret (ADR 0013). Never logged. */
  token: string
  /** Per-attempt timeout; defaults to {@link VOICE_RECORDING_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Retries after a failed attempt; defaults to {@link VOICE_RECORDING_RETRIES}. */
  retries?: number
  /** The HTTP client; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Waits between attempts; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
  /** Jitter source in [0, 1); defaults to `Math.random`. */
  random?: () => number
}

const fail = (code: 'server.unavailable' | 'server.timeout'): AppError =>
  new AppError({
    code: ERRORS[code].code,
    status: ERRORS[code].status,
    message: ERRORS[code].message,
  })

/** The response body as the chunks a store reads. */
async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        return
      }
      yield next.value
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/**
 * Voice's internal Recording route over HTTP. 404 is `null`; 409 `recording.not_ready`, 401, 5xx and
 * a missing body are `server.unavailable` (the queue redelivers), a timeout is `server.timeout`.
 * Only a timeout, a network error and a 503 are retried here. The body streams: it is never held whole.
 */
export function createVoiceHttpRecordings(options: VoiceHttpOptions): VoiceRecordings {
  const base = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? VOICE_RECORDING_TIMEOUT_MS
  const retries = options.retries ?? VOICE_RECORDING_RETRIES
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  return {
    async open(organizationId, callId, { signal }) {
      let last = fail('server.unavailable')
      for (let n = 0; n <= retries; n++) {
        if (n > 0) {
          await sleep(BACKOFF_BASE_MS * 2 ** (n - 1) * (0.5 + random() / 2))
        }
        try {
          const response = await doFetch(
            `${base}/internal/v1/calls/${encodeURIComponent(callId)}/recording`,
            {
              method: 'GET',
              headers: {
                authorization: `Bearer ${options.token}`,
                'x-organization-id': organizationId,
                accept: 'audio/wav',
              },
              redirect: 'error',
              signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            }
          )
          if (response.status === 200 && response.body !== null) {
            return chunks(response.body)
          }
          await response.body?.cancel().catch(() => {})
          if (response.status === 404) {
            return null
          }
          if (response.status !== 503) {
            throw fail('server.unavailable')
          }
          last = fail('server.unavailable')
        } catch (error) {
          if (error instanceof AppError) {
            throw error
          }
          if (signal.aborted) {
            throw error
          }
          last = fail(
            error instanceof Error && error.name === 'TimeoutError'
              ? 'server.timeout'
              : 'server.unavailable'
          )
        }
      }
      throw last
    },
  }
}
