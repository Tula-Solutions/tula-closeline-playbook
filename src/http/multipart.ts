/** Why a streamed multipart body could not be read. It never carries a field value, a name or a byte of a file. */
export class MultipartError extends Error {
  constructor(readonly reason: 'malformed' | 'field_too_large') {
    super(`the multipart body could not be read: ${reason}`)
    this.name = 'MultipartError'
  }
}

/** One part of a multipart body: its names, and its bytes as a stream that must be read to the end before the next part. */
export type StreamedPart = {
  /** The form field name. */
  name: string
  /** The file name, when the part is a file. */
  fileName: string | undefined
  /** The part's declared content type, when it has one. */
  contentType: string | undefined
  /** The part's bytes. Read it to the end (or let `next` drain it) before asking for the next part. */
  body: AsyncIterable<Uint8Array>
}

/** The parts of a multipart body, one at a time, in order. */
export type MultipartParts = {
  /** The next part, or `undefined` after the closing boundary. Throws {@link MultipartError} for a body that is not well formed. */
  next(): Promise<StreamedPart | undefined>
}

/** The longest header block of one part, in bytes. */
const MAX_HEADER_BYTES = 8192

/** The longest boundary RFC 2046 allows. */
const MAX_BOUNDARY_LENGTH = 70

const CRLF = Buffer.from('\r\n')
const HEADER_END = Buffer.from('\r\n\r\n')
const DASHES = Buffer.from('--')

/** The boundary named by a `multipart/form-data` content type, or `undefined` when there is none or it is not acceptable. */
export function boundaryOf(contentType: string): string | undefined {
  const match = /;\s*boundary=(?:"([^"]+)"|([^\s;"]+))/i.exec(contentType)
  const boundary = match?.[1] ?? match?.[2]
  return boundary !== undefined && boundary.length <= MAX_BOUNDARY_LENGTH ? boundary : undefined
}

/** Concatenates two byte arrays without copying when one is empty. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) {
    return b
  }
  const joined = new Uint8Array(a.byteLength + b.byteLength)
  joined.set(a, 0)
  joined.set(b, a.byteLength)
  return joined
}

/** `indexOf` over a `Uint8Array` with a `Buffer` pattern. */
function indexOf(haystack: Uint8Array, needle: Buffer): number {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).indexOf(needle)
}

/** Reads `name="..."` style parameters out of a header value; the value is never logged. */
function parameter(header: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[;\\s])${name}="((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(header)
  return match?.[1]?.replace(/\\(.)/g, '$1')
}

/**
 * Reads a `multipart/form-data` body as a stream, one part at a time, holding at most one chunk of
 * the source and a few bytes of look-behind: a 500 MB file part passes through in constant memory
 * (the platform's `formData()` would hold all of it). It reads only what the upload needs: the
 * first boundary must open the body (no preamble), part headers are at most
 * {@link MAX_HEADER_BYTES}, and a part whose name or disposition is missing is malformed. A source
 * that errors (a body over its cap or its deadline) rejects the read with that error unchanged.
 */
export function readMultipart(
  source: ReadableStream<Uint8Array>,
  boundary: string
): MultipartParts {
  const reader = source.getReader()
  const delimiter = Buffer.from(`--${boundary}`)
  const marker = Buffer.from(`\r\n--${boundary}`)
  let buffer: Uint8Array = new Uint8Array(0)
  let ended = false
  let started = false
  let finished = false
  let open: { drained: boolean } | undefined

  const fill = async (): Promise<boolean> => {
    if (ended) {
      return false
    }
    const read = await reader.read()
    if (read.done) {
      ended = true
      return false
    }
    buffer = concat(buffer, read.value)
    return true
  }

  /** Ensures the buffer holds at least `count` bytes, or throws when the body ends first. */
  const need = async (count: number): Promise<void> => {
    while (buffer.byteLength < count) {
      if (!(await fill())) {
        throw new MultipartError('malformed')
      }
    }
  }

  const startsWith = (prefix: Buffer): boolean =>
    Buffer.from(
      buffer.buffer,
      buffer.byteOffset,
      Math.min(buffer.byteLength, prefix.length)
    ).equals(prefix)

  /** The bytes of the current part, chunk by chunk, ending when the boundary that closes it has been consumed. */
  async function* bodyOf(state: { drained: boolean }): AsyncGenerator<Uint8Array> {
    for (;;) {
      const at = indexOf(buffer, marker)
      if (at >= 0) {
        const last = buffer.subarray(0, at)
        buffer = buffer.subarray(at + marker.length)
        state.drained = true
        if (last.byteLength > 0) {
          yield last
        }
        return
      }
      // Keep a marker's worth of look-behind: the boundary may straddle two chunks.
      const safe = buffer.byteLength - (marker.length - 1)
      if (safe > 0) {
        const out = buffer.subarray(0, safe)
        buffer = buffer.subarray(safe)
        yield out
      }
      if (!(await fill())) {
        throw new MultipartError('malformed')
      }
    }
  }

  return {
    async next() {
      if (finished) {
        return undefined
      }
      if (open !== undefined && !open.drained) {
        // The caller left the part unread: read it out (the source's own cap bounds the cost).
        for await (const _ of bodyOf(open)) {
          // discarded
        }
      }
      if (!started) {
        await need(delimiter.length)
        if (!startsWith(delimiter)) {
          throw new MultipartError('malformed')
        }
        buffer = buffer.subarray(delimiter.length)
        started = true
      }
      await need(2)
      if (startsWith(DASHES)) {
        finished = true
        await reader.cancel().catch(() => undefined)
        return undefined
      }
      if (!startsWith(CRLF)) {
        throw new MultipartError('malformed')
      }
      buffer = buffer.subarray(CRLF.length)
      // The header block ends at the first blank line.
      let end = indexOf(buffer, HEADER_END)
      while (end < 0) {
        if (buffer.byteLength > MAX_HEADER_BYTES || !(await fill())) {
          throw new MultipartError('malformed')
        }
        end = indexOf(buffer, HEADER_END)
      }
      if (end > MAX_HEADER_BYTES) {
        throw new MultipartError('malformed')
      }
      const headers = new TextDecoder().decode(buffer.subarray(0, end))
      buffer = buffer.subarray(end + HEADER_END.length)
      let disposition: string | undefined
      let contentType: string | undefined
      for (const line of headers.split('\r\n')) {
        const colon = line.indexOf(':')
        const key = line.slice(0, colon).trim().toLowerCase()
        if (key === 'content-disposition') {
          disposition = line.slice(colon + 1)
        } else if (key === 'content-type') {
          contentType = line.slice(colon + 1).trim()
        }
      }
      const name = disposition === undefined ? undefined : parameter(disposition, 'name')
      if (
        disposition === undefined ||
        name === undefined ||
        !/^\s*form-data\s*(;|$)/i.test(disposition)
      ) {
        throw new MultipartError('malformed')
      }
      const state = { drained: false }
      open = state
      return {
        name,
        fileName: parameter(disposition, 'filename'),
        contentType,
        body: bodyOf(state),
      }
    },
  }
}

/** Reads a small text part to the end, at most `maxBytes`; a longer one is {@link MultipartError} `field_too_large`, bad UTF-8 `malformed`. */
export async function readTextPart(part: StreamedPart, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of part.body) {
    size += chunk.byteLength
    if (size > maxBytes) {
      throw new MultipartError('field_too_large')
    }
    chunks.push(chunk)
  }
  const whole = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    whole.set(chunk, at)
    at += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(whole)
  } catch {
    throw new MultipartError('malformed')
  }
}
