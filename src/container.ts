import { sql } from 'drizzle-orm'
import type { RequestId } from 'tula-closeline-contract'
import {
  createDb,
  ORGANIZATIONS_WITH_WORK,
  type Transaction,
  type WorkDiscoveryRow,
  withOrganization,
} from 'tula-closeline-db'
import {
  type Clock,
  createErrorReporter,
  createLogger,
  createRemoteKeySet,
  createTokenVerifier,
  type LogDestination,
  type Logger,
  type ObjectStore,
  type ProcessedStore,
  type Queue,
  type Sleep,
  systemClock,
  systemSleep,
  type TokenVerifier,
  type Transcriber,
  type VectorStore,
} from 'tula-closeline-kit'
import { type Consumer, createSqsQueue } from 'tula-closeline-kit/queue'
import { createS3ObjectStore } from 'tula-closeline-kit/storage'
import {
  createMemoryObjectStore,
  createMemoryQueue,
  createMemoryTranscriber,
  createMemoryVectorStore,
} from 'tula-closeline-kit/testing'
import { createBedrockEmbedder } from '~/adapters/bedrock/embedder'
import { createMemoryEmbedder } from '~/adapters/memory/embedder'
import { createEmptyOcrReader } from '~/adapters/memory/ocr'
import { createMemorySuggestionPhraser } from '~/adapters/memory/suggestion-phraser'
import { createDocumentParserFor } from '~/adapters/parser'
import {
  createPostgresProcessedStore,
  type Discover,
  type InScope,
  organizationIsRemoved,
  scopeOver,
  statementOf,
  withoutRemovedOrganizations,
} from '~/adapters/postgres/processed-store'
import { createVoiceHttpRecordings } from '~/adapters/voice-http/recordings'
import { createHandlers, createPlaybookConsumer } from '~/consumer'
import { describeError } from '~/describe-error'
import { type Env, fakePortsOf, loadEnv } from '~/env'
import { SERVICE } from '~/info'
import {
  type ExportReplyEnvelope,
  exportReplyRegistry,
  type PlaybookEnvelope,
  registry,
} from '~/messages'
import type { Embedder } from '~/ports/embedder'
import type { OcrReader } from '~/ports/ocr'
import type { DocumentParser } from '~/ports/parser'
import type { SuggestionPhraser } from '~/ports/suggestion-phraser'
import type { VoiceRecordings } from '~/ports/voice-recordings'
import { trackerSafe } from '~/tracker-safe'
import { createWorkers, type Workers } from '~/workers'

/** One dependency probe for `/readyz`: resolve when healthy, reject or stall when not. */
export type ReadinessCheck = {
  /** A short stable name, reported to the caller, never an address or credential. */
  name: string
  /** Probes the dependency; `signal` aborts when the check has run out of time. */
  run: (signal: AbortSignal) => Promise<void>
}

/** What `reportError` is told about the request that failed. */
export type ErrorContext = {
  requestId: RequestId
  /** The Organization of the verified token, when the request got that far. */
  organizationId?: string | undefined
  method: string
  /** The path only, never the query string, which can carry secrets. */
  path: string
  /** The HTTP status of the response sent to the client, which can differ from the error's own. */
  status: number
}

/** Everything a request needs from outside the process, built once in {@link createContainer}. */
export type Container = {
  env: Env
  logger: Logger
  clock: Clock
  /** Checks access tokens offline against the auth service's published keys. */
  tokenVerifier: TokenVerifier
  /**
   * Runs `fn` in a transaction scoped to one Organization. The only way any module reaches the
   * database: a bare connection is never handed out.
   */
  withOrganization: <T>(organizationId: string, fn: (tx: Transaction) => Promise<T>) => Promise<T>
  /**
   * `withOrganization` for the db library's parameterised statements: opens the same
   * Organization-scoped transaction and hands `fn` a function that runs one statement text with
   * its values. Every module reaches the database through this or `withOrganization`.
   */
  scope: InScope
  /**
   * Work discovery (`ORGANIZATIONS_WITH_WORK`): the one statement that runs unscoped. It is the
   * only statement of a transaction of its own, which commits at once, as the db library requires.
   */
  discover: Discover
  /** Waits for a timer; real time here, virtual time in tests. Workers sleep through this only. */
  sleep: Sleep
  /** A number in [0, 1) for jitter; `Math.random` here, fixed in tests. */
  random: () => number
  /** The background workers: the ingestion job loop and the sweeps. Started by `server.ts`. */
  workers: Workers
  /** The ingestion queue: SQS when `QUEUE_URL` is set, otherwise in memory (local and tests only). */
  queue: Queue<PlaybookEnvelope>
  /** Core's jobs queue, where an export slice reports `export.part_ready` or `export.part_failed`: SQS when `CORE_JOBS_QUEUE_URL` is set, otherwise in memory (local and tests only). */
  exportQueue: Queue<ExportReplyEnvelope>
  /** Uploaded files: S3 when `STORAGE_BUCKET` is set, otherwise in memory (local and tests only). */
  objects: ObjectStore
  /**
   * The vector index. Memory only: the real adapter (turbopuffer, ADR 0010) is blocked on hub
   * issue 48, so nothing written here survives a restart. The pipeline writes to it; with the
   * memory adapter a restart loses vectors that Postgres says are `ready`, so this is for local
   * runs and tests only.
   */
  vectors: VectorStore
  /** Which queue messages are done; Postgres, so any instance can be stopped at any time. */
  processed: ProcessedStore
  /** Turns text into vectors: Cohere Embed v4 on Bedrock with `EMBEDDER=bedrock`, else a fake. */
  embedder: Embedder
  /** Phrases the Suggestions an Agent's won calls prove. A memory stand-in only; no vendor adapter (ADR 0010). */
  phraser: SuggestionPhraser
  /** Extracts the text layer of a document. A fake until a real adapter exists (ADR 0010). */
  parser: DocumentParser
  /** Reads pages with no text layer. A fake until a real adapter exists (ADR 0010). */
  ocr: OcrReader
  /**
   * Turns a Recording into speaker turns (ADR 0010, 0018). The kit's stand-in until the AssemblyAI
   * adapter exists: no real audio leaves the service, and the workers are refused outside `local`
   * while this is a fake ({@link fakePortsOf}).
   */
  transcriber: Transcriber
  /** Opens an ended Call's Recording at voice over the internal call (ADR 0013). */
  voiceRecordings: VoiceRecordings
  /** The queue consumer; built here, started by `server.ts` and stopped on shutdown. */
  consumer: Consumer
  /** Probes run by `/readyz`: the database. */
  readinessChecks: readonly ReadinessCheck[]
  /**
   * The one place unexpected errors go: the kit's error reporter (Sentry when `SENTRY_DSN` is set)
   * and a log line. It must not throw and must not return anything to a client.
   */
  reportError: (error: unknown, context: ErrorContext) => void
  /** Delivers pending error reports and releases the database connections; safe to call twice. */
  close: () => Promise<void>
  /**
   * Set once shutdown begins: `/readyz` answers 503 from then on, before the server stops.
   * `drainingSince` is when the first signal arrived (epoch ms from `clock`), for shutdown only.
   */
  lifecycle: { draining: boolean; drainingSince?: number }
}

/**
 * Calls `reportError` so that it can neither throw nor leave a rejected promise behind, even if
 * an implementation wrongly went async.
 */
export function reportSafely(container: Container, error: unknown, context: ErrorContext): void {
  try {
    const result: unknown = container.reportError(error, context)
    if (result instanceof Promise) {
      result.catch(() => {})
    }
  } catch {
    // A failing reporter must never turn a handled error into a dropped response.
  }
}

/** Options for {@link createContainer}. */
export type ContainerOptions = {
  /** Where log lines go; defaults to stdout. */
  logDestination?: LogDestination
}

/** How long `close` waits for the error reporter to deliver what it holds. */
const REPORTER_CLOSE_MS = 2_000

/** The SQS queue when `QUEUE_URL` is set, otherwise the kit's memory queue. */
function createQueue(env: Env): Queue<PlaybookEnvelope> {
  if (env.QUEUE_URL === undefined) {
    return createMemoryQueue({ registry, clock: systemClock })
  }
  return createSqsQueue({
    queueUrl: env.QUEUE_URL,
    region: env.AWS_REGION,
    environment: env.ENVIRONMENT,
    registry,
    ...(env.QUEUE_ENDPOINT === undefined ? {} : { endpoint: env.QUEUE_ENDPOINT }),
  })
}

/** The SQS queue of core's jobs when `CORE_JOBS_QUEUE_URL` is set, otherwise the kit's memory queue. */
function createExportQueue(env: Env): Queue<ExportReplyEnvelope> {
  if (env.CORE_JOBS_QUEUE_URL === undefined) {
    return createMemoryQueue({ registry: exportReplyRegistry, clock: systemClock })
  }
  return createSqsQueue({
    queueUrl: env.CORE_JOBS_QUEUE_URL,
    region: env.AWS_REGION,
    environment: env.ENVIRONMENT,
    registry: exportReplyRegistry,
    ...(env.QUEUE_ENDPOINT === undefined ? {} : { endpoint: env.QUEUE_ENDPOINT }),
  })
}

/** The S3 object store when `STORAGE_BUCKET` is set, otherwise the kit's memory store. */
function createObjects(env: Env, logger: Logger): ObjectStore {
  if (env.STORAGE_BUCKET === undefined) {
    return createMemoryObjectStore({ maxObjectBytes: env.MAX_UPLOAD_BYTES })
  }
  return createS3ObjectStore({
    bucket: env.STORAGE_BUCKET,
    region: env.AWS_REGION,
    environment: env.ENVIRONMENT,
    maxObjectBytes: env.MAX_UPLOAD_BYTES,
    logger,
    ...(env.STORAGE_ENDPOINT === undefined ? {} : { endpoint: env.STORAGE_ENDPOINT }),
  })
}

/**
 * The single composition root: the only place adapters and process-wide objects are constructed.
 * The real SQS and S3 adapters are built only when their settings are present; otherwise the
 * kit's memory adapters stand in, which `loadEnv` allows only in `local`.
 */
export function createContainer(env: Env = loadEnv(), options: ContainerOptions = {}): Container {
  const logger = createLogger({
    service: SERVICE,
    level: env.LOG_LEVEL,
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  })
  // Every error passes through the scrub: a Postgres error's detail can hold a row (issue 76).
  const errors = trackerSafe(
    createErrorReporter({
      dsn: env.SENTRY_DSN,
      service: SERVICE,
      environment: env.ENVIRONMENT,
      region: env.REGION,
      release: env.GIT_SHA,
      logger,
    })
  )

  const database = createDb(env.DATABASE_URL)
  const keys = createRemoteKeySet({
    url: env.AUTH_JWKS_URL,
    allowInsecureLocalhost: env.ENVIRONMENT === 'local',
    clock: systemClock,
    logger,
  })

  if (env.ENVIRONMENT !== 'local') {
    // Names only: a deployed process on a fake would otherwise look healthy while it embeds
    // nothing real. Remove a name from here as its real adapter lands.
    logger.warn('ports still on fakes', {
      ports: fakePortsOf(env),
    })
  }

  const queue = createQueue(env)
  const exportQueue = createExportQueue(env)
  const objects = createObjects(env, logger)
  const embedder =
    env.EMBEDDER === 'bedrock'
      ? createBedrockEmbedder({
          region: env.AWS_REGION,
          dimensions: env.EMBEDDING_DIMENSIONS,
          timeoutMs: env.INGESTION_IO_TIMEOUT_MS,
        })
      : createMemoryEmbedder()
  const phraser = createMemorySuggestionPhraser()
  const scope = scopeOver(database.db)
  const discover: Discover = (kind, after, batch) =>
    // Unscoped, and the only statement of its transaction (db README, ADR 0017).
    database.db.transaction(async (tx) => {
      const result = await tx.execute(statementOf(ORGANIZATIONS_WITH_WORK, [kind, after, batch]))
      return result.rows as unknown as WorkDiscoveryRow[]
    })
  // A message of a removed Organization is acknowledged without a record (see the wrapper).
  const processed = withoutRemovedOrganizations(
    createPostgresProcessedStore({ scope, discover, now: () => systemClock.now() }),
    (organizationId) => organizationIsRemoved(scope, organizationId)
  )
  const vectors = createMemoryVectorStore({ dimensions: embedder.dimensions })
  const parser = createDocumentParserFor(env)
  // No real reader yet: a scanned page reads as empty, so such a document ends `no_text`.
  const ocr = createEmptyOcrReader()
  // No real adapter yet (blocked on the vendor account and ADR 0018's preconditions): the stand-in.
  const transcriber = createMemoryTranscriber({ environment: env.ENVIRONMENT })
  // Unset outside local would drop Calls silently, so there it fails and the queue redelivers.
  const voiceRecordings: VoiceRecordings =
    env.VOICE_INTERNAL_URL !== undefined && env.VOICE_INTERNAL_TOKEN !== undefined
      ? createVoiceHttpRecordings({
          baseUrl: env.VOICE_INTERNAL_URL,
          token: env.VOICE_INTERNAL_TOKEN,
        })
      : {
          open: async () => {
            if (env.ENVIRONMENT !== 'local') {
              throw new Error('VOICE_INTERNAL_URL is not set')
            }
            return null
          },
        }
  const random = Math.random
  const reportError: Container['reportError'] = (error, context) => {
    logger.error('unhandled error', { ...context, error: describeError(error) })
    errors.capture(error, context)
  }
  const pipeline = {
    scope,
    discover,
    objects,
    vectors,
    embedder,
    phraser,
    parser,
    ocr,
    transcriber,
    voiceRecordings,
    logger,
    clock: systemClock,
    env,
    sleep: systemSleep,
    random,
    reportError,
    queue,
    exportQueue,
  }
  const workers = createWorkers(pipeline, processed)

  const consumer = createPlaybookConsumer({
    queue,
    store: processed,
    logger,
    errorReporter: errors,
    handlers: createHandlers(pipeline, workers.ingestion.nudge),
    concurrency: env.CONSUMER_CONCURRENCY,
  })

  return {
    env,
    logger,
    clock: systemClock,
    tokenVerifier: createTokenVerifier({
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      keys,
      clock: systemClock,
    }),
    withOrganization: (organizationId, fn) => withOrganization(database.db, organizationId, fn),
    scope,
    discover,
    sleep: systemSleep,
    random,
    workers,
    queue,
    exportQueue,
    objects,
    vectors,
    processed,
    embedder,
    phraser,
    parser,
    ocr,
    transcriber,
    voiceRecordings,
    consumer,
    readinessChecks: [
      {
        name: 'database',
        run: async () => {
          await database.db.execute(sql`select 1`)
        },
      },
    ],
    lifecycle: { draining: false },
    reportError,
    close: async () => {
      await errors.close(REPORTER_CLOSE_MS)
      await database.close()
    },
  }
}
