import { describe, expect, test } from 'bun:test'
import { boundaryOf, MultipartError, readMultipart, readTextPart } from './multipart'

/** A multipart body and its content type, cut into chunks of `size` bytes so a boundary can straddle two of them. */
async function encode(form: FormData, size: number) {
  const response = new Response(form)
  const contentType = response.headers.get('content-type') ?? ''
  const bytes = new Uint8Array(await response.arrayBuffer())
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.byteLength; at += size) {
        controller.enqueue(bytes.slice(at, at + size))
      }
      controller.close()
    },
  })
  return { stream, boundary: boundaryOf(contentType) ?? '' }
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of body) {
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

describe('boundaryOf', () => {
  test('reads a plain and a quoted boundary, and refuses a missing or overlong one', () => {
    expect(boundaryOf('multipart/form-data; boundary=abc123')).toBe('abc123')
    expect(boundaryOf('multipart/form-data; boundary="a b"')).toBe('a b')
    expect(boundaryOf('multipart/form-data')).toBeUndefined()
    expect(boundaryOf(`multipart/form-data; boundary=${'x'.repeat(71)}`)).toBeUndefined()
  })
})

describe('readMultipart', () => {
  test('reads fields and a binary file in order, whatever the chunk size', async () => {
    const file = new Uint8Array(10_000).map((_, i) => (i * 31) % 251)
    for (const size of [1, 7, 64, 1000, 100_000]) {
      const form = new FormData()
      form.append('dealId', 'DEAL-1')
      form.append('file', new File([file], 'call.mp3', { type: 'audio/mpeg' }))
      form.append('rep', '{"by":"channel","channel":"left"}')
      const { stream, boundary } = await encode(form, size)
      const parts = readMultipart(stream, boundary)

      const first = await parts.next()
      expect(first?.name).toBe('dealId')
      expect(await readTextPart(first as never, 100)).toBe('DEAL-1')
      const second = await parts.next()
      expect(second).toMatchObject({
        name: 'file',
        fileName: 'call.mp3',
        contentType: 'audio/mpeg',
      })
      expect(await collect((second as never as { body: AsyncIterable<Uint8Array> }).body)).toEqual(
        file
      )
      const third = await parts.next()
      expect(third?.name).toBe('rep')
      expect(await readTextPart(third as never, 100)).toBe('{"by":"channel","channel":"left"}')
      expect(await parts.next()).toBeUndefined()
    }
  })

  test('a file that holds the boundary text inside is read whole', async () => {
    const form = new FormData()
    const inside = new TextEncoder().encode('\r\n--not-quite\r\n--')
    form.append('file', new File([inside], 'a.txt'))
    const { stream, boundary } = await encode(form, 3)
    const part = await readMultipart(stream, boundary).next()
    expect(await collect((part as never as { body: AsyncIterable<Uint8Array> }).body)).toEqual(
      inside
    )
  })

  test('an unread part is skipped when the next one is asked for', async () => {
    const form = new FormData()
    form.append('file', new File(['x'.repeat(5000)], 'a.txt'))
    form.append('dealId', 'D')
    const { stream, boundary } = await encode(form, 100)
    const parts = readMultipart(stream, boundary)
    expect((await parts.next())?.name).toBe('file')
    const next = await parts.next()
    expect(await readTextPart(next as never, 10)).toBe('D')
  })

  test('an empty file part is read as no bytes', async () => {
    const form = new FormData()
    form.append('file', new File([], 'a.txt'))
    const { stream, boundary } = await encode(form, 5)
    const part = await readMultipart(stream, boundary).next()
    expect(await collect((part as never as { body: AsyncIterable<Uint8Array> }).body)).toEqual(
      new Uint8Array(0)
    )
  })

  test('a text part over its limit is refused without echoing it', async () => {
    const form = new FormData()
    form.append('rep', 'y'.repeat(50))
    const { stream, boundary } = await encode(form, 16)
    const part = await readMultipart(stream, boundary).next()
    const error = await readTextPart(part as never, 10).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MultipartError)
    expect(String((error as Error).message)).not.toContain('yyy')
  })

  test('a body that is cut short, has a preamble or lacks a disposition is malformed', async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('--b\r\nContent-Disposition: form-data; name="f"\r\n\r\nabc')
        )
        controller.close()
      },
    })
    const parts = readMultipart(cut, 'b')
    const part = await parts.next()
    await expect(
      collect((part as never as { body: AsyncIterable<Uint8Array> }).body)
    ).rejects.toBeInstanceOf(MultipartError)

    const preamble = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('junk--b\r\n'))
        controller.close()
      },
    })
    await expect(readMultipart(preamble, 'b').next()).rejects.toBeInstanceOf(MultipartError)

    const noDisposition = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('--b\r\nX-Other: 1\r\n\r\nabc\r\n--b--\r\n'))
        controller.close()
      },
    })
    await expect(readMultipart(noDisposition, 'b').next()).rejects.toBeInstanceOf(MultipartError)
  })

  test('an error from the source passes through unchanged', async () => {
    const boom = new Error('cut off')
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(boom)
      },
    })
    await expect(readMultipart(source, 'b').next()).rejects.toBe(boom)
  })
})
