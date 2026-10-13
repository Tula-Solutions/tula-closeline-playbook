import type { DocumentMediaType } from 'tula-closeline-contract'
import { z } from 'zod'
import type { Env } from '~/env'
import { type DocumentParser, type ParsedDocument, ParseError } from '~/ports/parser'
import type { ParserLimits } from './limits'
import type { WorkerRequest } from './worker'

/** How often the host looks at the process's memory while a parse runs, in ms. */
const MEMORY_POLL_MS = 50

/** Settings of {@link createDocumentParser}. */
export type DocumentParserOptions = {
  /** The page and text limits handed to every parse. */
  limits: ParserLimits
  /** The hard time limit of one document, in ms; the worker is terminated when it passes. */
  timeoutMs: number
  /** The most the process's resident memory may grow while one document parses, in bytes. */
  memoryLimitBytes: number
  /** The worker script; tests point it at a stand-in. Defaults to the real parsing worker. */
  workerUrl?: URL
  /** Reads the process's resident memory; tests replace it. */
  residentBytes?: () => number
}

/** The schema a worker's reply must satisfy under `limits`: it crossed a thread boundary, so it is untrusted. */
function replySchema(limits: ParserLimits) {
  const page = z.object({
    number: z.number().int().min(1),
    text: z.string(),
    needsOcr: z.boolean(),
  })
  const accepted = z.object({
    ok: z.literal(true),
    document: z
      .object({ pages: z.array(page).max(limits.maxPages) })
      .refine(
        ({ pages }) => pages.reduce((sum, p) => sum + p.text.length, 0) <= limits.maxTextChars
      ),
  })
  const refused = z.object({
    ok: z.literal(false),
    reason: z.enum(['unreadable', 'password_protected', 'too_many_pages', 'processing_failed']),
    pageCount: z.number().int().min(0).optional(),
  })
  return z.discriminatedUnion('ok', [accepted, refused])
}

/**
 * Creates the real {@link DocumentParser}: PDF, DOCX, PPTX, TXT and MD. Each document is parsed in
 * its own Bun `Worker`, a separate thread, so a hostile file never blocks the main event loop (the
 * job's heartbeat keeps running) and can be killed: the host terminates the worker when the hard
 * time limit passes, when the signal aborts, or when the process's resident memory has grown past
 * the memory limit since the parse began (checked every {@link MEMORY_POLL_MS} ms, because Bun
 * does not enforce `resourceLimits` on a Worker). A crash, hang or runaway allocation ends in a
 * {@link ParseError} of `processing_failed`, never in the service. No retry is made inside: every
 * failure here is a property of the file, so a second attempt would fail the same way. Nothing
 * from a file is logged and no error message holds any of it.
 */
export function createDocumentParser(options: DocumentParserOptions): DocumentParser {
  const url = options.workerUrl ?? new URL('./worker.ts', import.meta.url)
  const resident = options.residentBytes ?? (() => process.memoryUsage.rss())
  return {
    parse: async (document, { signal }) => {
      signal.throwIfAborted()
      return runInWorker(document, signal, url, resident, options)
    },
  }
}

/** Runs one parse in a fresh worker and always ends the worker. */
function runInWorker(
  document: { bytes: Uint8Array; mediaType: DocumentMediaType },
  signal: AbortSignal,
  url: URL,
  resident: () => number,
  options: DocumentParserOptions
): Promise<ParsedDocument> {
  return new Promise<ParsedDocument>((resolve, reject) => {
    const worker = new Worker(url.href, { smol: true })
    const schema = replySchema(options.limits)
    const baseline = resident()
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      clearInterval(memory)
      signal.removeEventListener('abort', onAbort)
      worker.terminate()
      settle()
    }
    const fail = (reason: 'processing_failed' | 'unreadable', pageCount?: number) =>
      finish(() => reject(new ParseError(reason, { pageCount })))
    const deadline = setTimeout(() => fail('processing_failed'), options.timeoutMs)
    const memory = setInterval(() => {
      if (resident() - baseline > options.memoryLimitBytes) {
        fail('processing_failed')
      }
    }, MEMORY_POLL_MS)
    const onAbort = () => finish(() => reject(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const checked = schema.safeParse(event.data)
      if (!checked.success) {
        fail('processing_failed')
      } else if (checked.data.ok) {
        const { document: parsed } = checked.data
        finish(() => resolve(parsed))
      } else {
        const { reason, pageCount } = checked.data
        finish(() => reject(new ParseError(reason, { pageCount })))
      }
    }
    // A thrown error, a message that cannot be cloned and a worker that exits are all the file's doing.
    worker.onerror = (event) => {
      event.preventDefault()
      fail('processing_failed')
    }
    worker.onmessageerror = () => fail('processing_failed')
    worker.addEventListener('close', () => fail('processing_failed'))

    // The worker gets its own copy: the caller keeps its bytes for the OCR call.
    const bytes = document.bytes.slice()
    const request: WorkerRequest = { bytes, mediaType: document.mediaType, limits: options.limits }
    try {
      worker.postMessage(request, [bytes.buffer])
    } catch {
      fail('processing_failed')
    }
  })
}

/**
 * The parser as the service runs it: the pipeline's page and text limits, the parse timeout
 * (the parser ends a hung worker at 90% of `INGESTION_PARSE_TIMEOUT_MS`, so its answer, a
 * permanent `processing_failed`, comes before the job's own timeout, which would be retried) and
 * the memory bound.
 */
export function createDocumentParserFor(
  env: Pick<
    Env,
    | 'MAX_PAGES_PER_DOCUMENT'
    | 'MAX_TEXT_CHARS_PER_DOCUMENT'
    | 'INGESTION_PARSE_TIMEOUT_MS'
    | 'PARSER_MEMORY_LIMIT_BYTES'
  >
): DocumentParser {
  return createDocumentParser({
    limits: {
      maxPages: env.MAX_PAGES_PER_DOCUMENT,
      maxTextChars: env.MAX_TEXT_CHARS_PER_DOCUMENT,
    },
    timeoutMs: Math.floor(env.INGESTION_PARSE_TIMEOUT_MS * 0.9),
    memoryLimitBytes: env.PARSER_MEMORY_LIMIT_BYTES,
  })
}
