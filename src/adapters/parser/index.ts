import type { DocumentMediaType } from 'tula-closeline-contract'
import { z } from 'zod'
import type { Env } from '~/env'
import { type DocumentParser, type ParsedDocument, ParseError } from '~/ports/parser'
import type { ParserLimits } from './limits'
import type { WorkerRequest } from './worker'

/** How often the host looks at the process's memory while a parse runs, in ms. */
const MEMORY_POLL_MS = 50

/**
 * Thrown when a parse was ended because the process ran out of its memory budget while other
 * parses were running, so this file may not be the cause. It is not a {@link ParseError}: the job
 * treats it as worth another attempt (bounded by `INGESTION_MAX_ATTEMPTS`, with backoff), and a
 * file that trips the limit while it runs alone fails for good.
 */
export class ParserOverloaded extends Error {
  /** Creates the error; the message never holds content. */
  constructor() {
    super('the parser ran out of memory while other documents were parsing')
    this.name = 'ParserOverloaded'
  }
}

/**
 * Thrown when handing the document to the worker failed (the transfer, not the file): worth
 * another attempt, so it is not a {@link ParseError}.
 */
export class ParserTransferFailed extends Error {
  /** Creates the error; the message never holds content. */
  constructor() {
    super('the document could not be handed to the parsing worker')
    this.name = 'ParserTransferFailed'
  }
}

/**
 * How long, in ms, parses on this instance run one at a time after a {@link ParserOverloaded}
 * event; another such event inside the window extends it. The job retries the ended parses, and
 * alone a healthy file finishes while a runaway one trips the memory limit by itself and fails for
 * good. This is scheduling state in this process only (it is not shared and not stored): any
 * instance can be stopped at any time, and a restart simply starts with the lane open.
 */
export const EXCLUSIVE_LANE_MS = 30_000

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
  /** The clock of the exclusive lane, in ms; tests replace it. */
  now?: () => number
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
  const now = options.now ?? (() => performance.now())
  const parses: LiveParses = { live: 0, contendedUntil: 0, exclusiveUntil: 0, waiters: new Set() }
  return {
    parse: async (document, { signal }) => {
      signal.throwIfAborted()
      // Waiting for the lane is not parse time: the document's own time limit starts when its
      // worker does. The job's call timeout covers the wait too, and a timeout there is retried.
      await enterLane(parses, signal, now)
      try {
        return await runInWorker(document, signal, url, resident, options, parses, now)
      } finally {
        leaveLane(parses)
      }
    },
  }
}

/** The parses running in one parser: the memory poll measures the whole process, so it must know who else is running. */
type LiveParses = {
  /** Parses with a worker running. */
  live: number
  /** Until this time (ms, real clock) a memory trip counts as shared, so the parses of one episode are judged alike. */
  contendedUntil: number
  /** Until this time (on the lane clock) a parse starts only when no other is running. */
  exclusiveUntil: number
  /** Parses waiting for the lane, woken whenever one ends. */
  waiters: Set<() => void>
}

/** Waits until the parse may start: at once outside the exclusive window, else when none is running; honours `signal`. */
async function enterLane(
  parses: LiveParses,
  signal: AbortSignal,
  now: () => number
): Promise<void> {
  while (now() < parses.exclusiveUntil && parses.live > 0) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        parses.waiters.delete(wake)
        reject(signal.reason)
      }
      parses.waiters.add(wake)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  signal.throwIfAborted()
  parses.live++
}

/** Frees the parse's place and lets the waiting parses look again. */
function leaveLane(parses: LiveParses): void {
  parses.live--
  const waiting = [...parses.waiters]
  parses.waiters.clear()
  for (const wake of waiting) {
    wake()
  }
}

/** Runs one parse in a fresh worker and always ends the worker. */
function runInWorker(
  document: { bytes: Uint8Array; mediaType: DocumentMediaType },
  signal: AbortSignal,
  url: URL,
  resident: () => number,
  options: DocumentParserOptions,
  parses: LiveParses,
  now: () => number
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
        const at = performance.now()
        if (parses.live > 1) {
          parses.contendedUntil = at + 2 * MEMORY_POLL_MS
        }
        if (at < parses.contendedUntil) {
          // Others were running (or just ended for this reason): the growth is not this file's alone.
          parses.exclusiveUntil = now() + EXCLUSIVE_LANE_MS
          finish(() => reject(new ParserOverloaded()))
        } else {
          fail('processing_failed')
        }
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
      // The transfer failed, not the file: let the job try again.
      finish(() => reject(new ParserTransferFailed()))
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
