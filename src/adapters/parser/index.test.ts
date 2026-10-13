import { describe, expect, test } from 'bun:test'
import { loadEnv } from '~/env'
import { ParseError } from '~/ports/parser'
import { parserBehaviour } from '~/ports/parser.behaviour'
import { DOCX_MEDIA_TYPE, PPTX_MEDIA_TYPE } from './extract'
import { createDocumentParser, createDocumentParserFor } from './index'
import { buildDocx, buildPdf, buildPptx } from './test-support'

const limits = { maxPages: 300, maxTextChars: 5_000_000 }
const real = () => createDocumentParser({ limits, timeoutMs: 30_000, memoryLimitBytes: 2 ** 31 })
const hostile = (overrides: { timeoutMs?: number; memoryLimitBytes?: number } = {}) =>
  createDocumentParser({
    limits,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    memoryLimitBytes: overrides.memoryLimitBytes ?? 2 ** 31,
    workerUrl: new URL('./fixtures/hostile-worker.ts', import.meta.url),
  })
const never = new AbortController().signal
/** A call that makes the stand-in worker misbehave in the named way (the mode rides in the media type). */
const misbehave = (mode: string) => ({ bytes: new Uint8Array(8), mediaType: mode as never })

async function failureOf(run: Promise<unknown>): Promise<ParseError> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(ParseError)
  return error as ParseError
}

parserBehaviour('the worker parser', () => ({
  parser: real(),
  readable: new TextEncoder().encode('some text\n\nmore text'),
  unreadable: new TextEncoder().encode('this is not a pdf'),
}))

describe('the worker parser parses each type off the main thread', () => {
  test.each([
    ['text/plain', new TextEncoder().encode('plain words'), 'plain words'],
    ['text/markdown', new TextEncoder().encode('# Title\n\nbody'), '# Title'],
    [DOCX_MEDIA_TYPE, buildDocx(['docx words']), 'docx words'],
    [PPTX_MEDIA_TYPE, buildPptx([['pptx words']]), 'pptx words'],
    ['application/pdf', buildPdf({ pages: ['pdf words'] }), 'pdf words'],
  ] as const)('%s', async (mediaType, bytes, expected) => {
    const parsed = await real().parse({ bytes, mediaType }, { signal: never })
    expect(parsed.pages[0]?.text).toContain(expected)
  })

  test('the caller keeps its bytes (the worker gets a copy)', async () => {
    const bytes = buildDocx(['x'])
    const before = bytes.length
    await real().parse({ bytes, mediaType: DOCX_MEDIA_TYPE }, { signal: never })
    expect(bytes.length).toBe(before)
  })

  test('reasons from the file come through, with the page count when it was known', async () => {
    const parser = createDocumentParser({
      limits: { ...limits, maxPages: 2 },
      timeoutMs: 30_000,
      memoryLimitBytes: 2 ** 31,
    })
    const error = await failureOf(
      parser.parse(
        { bytes: buildPdf({ pages: ['a', 'b', 'c', 'd'] }), mediaType: 'application/pdf' },
        { signal: never }
      )
    )
    expect(error.reason).toBe('too_many_pages')
    expect(error.pageCount).toBe(4)
    const locked = await failureOf(
      real().parse(
        { bytes: buildPdf({ pages: ['x'], encrypted: true }), mediaType: 'application/pdf' },
        { signal: never }
      )
    )
    expect(locked.reason).toBe('password_protected')
  })

  test('the main event loop keeps ticking while a 300-page PDF parses', async () => {
    const bytes = buildPdf({ pages: Array.from({ length: 300 }, (_v, i) => `page ${i + 1} text`) })
    let last = performance.now()
    let worst = 0
    const tick = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 10)
    try {
      const parsed = await real().parse({ bytes, mediaType: 'application/pdf' }, { signal: never })
      expect(parsed.pages).toHaveLength(300)
    } finally {
      clearInterval(tick)
    }
    // Generous: a parse on the main thread would block it for the whole second or more.
    expect(worst).toBeLessThan(250)
  }, 30_000)
})

describe('a parser that hangs, crashes or runs away fails the document, never the service', () => {
  test('a hang ends at the time limit as processing_failed, and the next parse works', async () => {
    const parser = hostile({ timeoutMs: 300 })
    const started = performance.now()

    const error = await failureOf(parser.parse(misbehave('spin'), { signal: never }))

    expect(error.reason).toBe('processing_failed')
    expect(performance.now() - started).toBeLessThan(3_000)
    const next = await parser.parse(misbehave('ok'), { signal: never })
    expect(next.pages[0]?.text).toBe('fine')
  })

  test('the main loop ticks during a hang', async () => {
    let ticks = 0
    const tick = setInterval(() => ticks++, 10)
    await failureOf(hostile({ timeoutMs: 400 }).parse(misbehave('spin'), { signal: never }))
    clearInterval(tick)
    expect(ticks).toBeGreaterThan(15)
  })

  test('runaway memory is cut off at the memory limit as processing_failed', async () => {
    const started = performance.now()

    const error = await failureOf(
      hostile({ memoryLimitBytes: 256 * 1024 * 1024 }).parse(misbehave('oom'), { signal: never })
    )

    expect(error.reason).toBe('processing_failed')
    expect(performance.now() - started).toBeLessThan(10_000)
  }, 20_000)

  test('a worker that throws, exits or answers nonsense is processing_failed, with no content in the error', async () => {
    for (const mode of ['throw', 'exit', 'garbage']) {
      const error = await failureOf(hostile().parse(misbehave(mode), { signal: never }))
      expect(error.reason).toBe('processing_failed')
      expect(String(error) + String(error.cause)).not.toContain('SECRET')
    }
  })

  test('an abort ends a running parse at once and rejects with the abort reason', async () => {
    const controller = new AbortController()
    const run = hostile().parse(misbehave('spin'), { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('shutting down')), 100)

    await expect(run).rejects.toThrow('shutting down')
  })

  test('twenty hanging parses in a row leave the process able to parse', async () => {
    const parser = hostile({ timeoutMs: 100 })
    for (let n = 0; n < 20; n++) {
      await failureOf(parser.parse(misbehave('spin'), { signal: never }))
    }
    expect(
      (
        await real().parse(
          { bytes: new TextEncoder().encode('ok'), mediaType: 'text/plain' },
          { signal: never }
        )
      ).pages
    ).toHaveLength(1)
  }, 30_000)
})

describe('createDocumentParserFor', () => {
  test('takes its limits from the environment', async () => {
    const env = loadEnv({ ENVIRONMENT: 'local', MAX_TEXT_CHARS_PER_DOCUMENT: '1000' })
    const parser = createDocumentParserFor(env)

    const ok = await parser.parse(
      { bytes: new TextEncoder().encode('short'), mediaType: 'text/plain' },
      { signal: never }
    )
    const over = await failureOf(
      parser.parse(
        { bytes: new TextEncoder().encode('x'.repeat(1001)), mediaType: 'text/plain' },
        { signal: never }
      )
    )

    expect(ok.pages).toHaveLength(1)
    expect(over.reason).toBe('processing_failed')
  })
})
