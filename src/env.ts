import {
  DEFAULT_MAX_DEALS,
  DEFAULT_MAX_DOCUMENT_BYTES_TOTAL,
  DEFAULT_MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_PAGES,
  regionSchema,
} from 'tula-closeline-contract'
import {
  EMBED_USAGE_MAX_MOMENTS,
  ORPHAN_SWEEP_MAX_CLAIM_MS,
  ORPHAN_SWEEP_MIN_CLAIM_MS,
  PLAYBOOK_MAX_BATCH,
} from 'tula-closeline-db'
import { environmentSchema, requireSentryDsn, sentryDsnSchema } from 'tula-closeline-kit'
import { z } from 'zod'

/** The most grace plus drain may add up to, so an orchestrator's kill window is not outlasted. */
const MAX_SHUTDOWN_TOTAL_MS = 60_000

/** The `closeline_playbook` login of the compose Postgres, used only when `ENVIRONMENT` is `local`. */
const LOCAL_DATABASE_URL =
  'postgres://closeline_playbook:closeline_playbook_local@127.0.0.1:5432/closeline'

/** The auth service's local address, used only when `ENVIRONMENT` is `local`. */
const LOCAL_AUTH_ORIGIN = 'http://127.0.0.1:3001'

/** The audience of every Closeline access token. */
const DEFAULT_AUTH_AUDIENCE = 'closeline'

/** The AWS Region a local run names; ElasticMQ and S3Mock ignore it but the SDK needs one. */
const LOCAL_AWS_REGION = 'us-east-1'

/** The most uploads one instance handles at once, whatever is configured: each is held in memory. */
export const MAX_CONCURRENT_UPLOADS_LIMIT = 16

/** The shortest internal API secret accepted, in characters. */
export const MIN_INTERNAL_TOKEN_LENGTH = 32

/** The most internal API secrets accepted at once; two is a rotation, more is a mistake. */
const MAX_INTERNAL_TOKENS = 5

/** The longest one internal API secret may be, so a pasted blob cannot be mistaken for one. */
const MAX_INTERNAL_TOKEN_LENGTH = 512

/**
 * The pipeline ports that have no real adapter yet (ADR 0010; the vector store waits on hub issue
 * 48). Remove a name as its real adapter lands; while any remains, the workers may not run outside
 * `local`, because they would mark real uploads `ready` over vectors that live in one process.
 */
export const PIPELINE_FAKE_PORTS = ['embedder', 'ocr', 'vector store', 'transcriber'] as const

/** The ports still on a fake for this configuration: the embedder is real when `EMBEDDER=bedrock`. */
export function fakePortsOf(env: { EMBEDDER?: 'memory' | 'bedrock' | undefined }): string[] {
  return PIPELINE_FAKE_PORTS.filter((port) => port !== 'embedder' || env.EMBEDDER !== 'bedrock')
}

/** A secret is printable ASCII with no space, so it travels in a bearer header unchanged. */
const PRINTABLE_ASCII = /^[!-~]+$/

/**
 * The internal secret a local run uses when none is set (ADR 0013). It is public: it is refused
 * in every environment but `local`, so a deploy that forgot to set a secret fails at boot.
 */
export const LOCAL_INTERNAL_API_TOKEN = 'local-playbook-internal-secret-not-for-deploys'

/** The keys that must be set in every environment but `local`, where they have defaults. */
const REQUIRED_OUTSIDE_LOCAL = [
  'REGION',
  'DATABASE_URL',
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'AUTH_AUDIENCE',
  'AWS_REGION',
  'QUEUE_URL',
  'CORE_JOBS_QUEUE_URL',
  'STORAGE_BUCKET',
  'INTERNAL_API_TOKENS',
] as const

/**
 * A whole number written as digits only, within bounds. Stricter than `z.coerce.number()`, which
 * turns `''` into 0 and reads ` 5`, `0x10` and `1e1` as numbers. The messages name the rule, never
 * the value.
 */
function integer(min: number, max: number) {
  return z
    .string()
    .regex(/^[0-9]{1,15}$/, 'must be a whole number written in digits')
    .transform(Number)
    .pipe(z.number().min(min).max(max))
}

const schema = z
  .object({
    /** Which deployment this is. No default: a deploy that forgets it must fail at boot. */
    ENVIRONMENT: environmentSchema,
    PORT: integer(1, 65535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    /** The longest one readiness check may take before it counts as failed. */
    READINESS_TIMEOUT_MS: integer(1, 30_000).default(2_000),
    /** The longest shutdown waits for in-flight requests before closing them. */
    SHUTDOWN_TIMEOUT_MS: integer(1, 120_000).default(10_000),
    /** How long `/readyz` reports 503 before the server stops accepting, so the balancer moves on. */
    SHUTDOWN_GRACE_MS: integer(0, 60_000).default(5_000),
    /**
     * The largest request body accepted by any route but the upload, in bytes; anything bigger is
     * a 413. The upload route has its own, larger limit (`MAX_UPLOAD_BYTES` plus multipart overhead).
     */
    MAX_REQUEST_BODY_BYTES: integer(1, 104_857_600).default(1_048_576),

    /** The Region this deployment serves; every Organization lives in the Region of its deployment. */
    REGION: regionSchema.optional(),
    /** The Sentry DSN of this Region's project; optional in `local`, required elsewhere. */
    SENTRY_DSN: sentryDsnSchema,
    /** The git SHA of the running build, sent to the error tracker as the release. */
    GIT_SHA: z.string().min(1).max(64).optional(),

    /** Postgres connection string of the `closeline_playbook` login. It carries a password: never log it. */
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string')
      .optional(),
    /** Where the auth service publishes its signing keys (https; http only when local). */
    AUTH_JWKS_URL: z.url().optional(),
    /** The `iss` every access token must carry. */
    AUTH_ISSUER: z.string().min(1).max(2_048).optional(),
    /** The `aud` every access token must carry. */
    AUTH_AUDIENCE: z.string().min(1).max(2_048).optional(),

    /** The AWS Region of the queue and the bucket (not the Closeline Region above). */
    AWS_REGION: z.string().min(1).max(64).optional(),
    /** Which embedder runs: `memory` (a fake, local only) or `bedrock` (Titan V2 in `AWS_REGION`). */
    EMBEDDER: z.enum(['memory', 'bedrock']).optional(),
    /** The vector length of the Bedrock embedder: 256, 512 or 1024. */
    EMBEDDING_DIMENSIONS: z.coerce
      .number()
      .pipe(z.union([z.literal(256), z.literal(512), z.literal(1024)]))
      .default(1024),
    /** The ingestion queue's URL. Unset in `local` means the in-memory queue; required elsewhere. */
    QUEUE_URL: z.url().max(2_048).optional(),
    /**
     * Core's jobs queue, where `export.part_ready` and `export.part_failed` go (M16). Unset in
     * `local` means an in-memory queue nobody reads; required elsewhere.
     */
    CORE_JOBS_QUEUE_URL: z.url().max(2_048).optional(),
    /** Where ElasticMQ listens, for a local run against it. Accepted only when `local`. */
    QUEUE_ENDPOINT: z.url().max(2_048).optional(),
    /** The bucket holding uploaded files. Unset in `local` means the in-memory store; required elsewhere. */
    STORAGE_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'STORAGE_BUCKET must be a valid bucket name')
      .optional(),
    /** Where S3Mock listens, for a local run against it. Accepted only when `local`. */
    STORAGE_ENDPOINT: z.url().max(2_048).optional(),

    /** The largest file accepted, in bytes. May lower the contract's limit (ADR 0016), never raise it. */
    MAX_UPLOAD_BYTES: integer(1, MAX_DOCUMENT_BYTES).optional(),
    /** Documents an Organization may hold, soft-deleted ones included until purged (ADR 0016). */
    MAX_DOCUMENTS_PER_ORGANIZATION: integer(1, 1_000_000).default(DEFAULT_MAX_DOCUMENTS),
    /** Bytes an Organization may hold, soft-deleted documents included until purged (ADR 0016). */
    MAX_BYTES_PER_ORGANIZATION: integer(1, 1_000_000_000_000).default(
      DEFAULT_MAX_DOCUMENT_BYTES_TOTAL
    ),
    /** The most pages a document may have. May lower the contract's limit, never raise it. */
    MAX_PAGES_PER_DOCUMENT: integer(1, MAX_DOCUMENT_PAGES).optional(),
    /**
     * Deals an Organization may hold (ADR 0018). A Deal import stops creating Deals at this number
     * and reports the rows it could not take as `deal_limit_reached`.
     */
    MAX_DEALS_PER_ORGANIZATION: integer(1, 1_000_000).default(DEFAULT_MAX_DEALS),
    /**
     * The most uploads one instance handles at once. Each is held whole in memory (ADR 0016), so
     * this times `MAX_UPLOAD_BYTES` is the upload memory an instance may need.
     */
    MAX_CONCURRENT_UPLOADS: integer(1, MAX_CONCURRENT_UPLOADS_LIMIT).default(4),
    /**
     * The longest an upload's body may take to arrive and be parsed, in milliseconds. A slow sender
     * holds one of `MAX_CONCURRENT_UPLOADS` places until it finishes, so a body not complete by
     * then is cut off with `server.timeout` (504) and the place is given back.
     */
    UPLOAD_BODY_TIMEOUT_MS: integer(100, 600_000).default(60_000),
    /**
     * The longest a Recording upload's body may take to arrive, in milliseconds (500 MB at about
     * 2.4 Mbit/s up fits in the default 30 minutes). The body is streamed to the object store, never
     * held, but the upload keeps one of `MAX_CONCURRENT_UPLOADS` places for as long as it runs; a
     * stream that stays silent is cut off sooner by the object store's own idle timeout.
     */
    RECORDING_BODY_TIMEOUT_MS: integer(1_000, 7_200_000).default(1_800_000),

    /**
     * The least a Recording upload must send, in bytes a second, measured over each
     * `RECORDING_RATE_WINDOW_MS`; a slower sender is cut off (`server.timeout`) so it cannot keep
     * one of the upload places for the whole `RECORDING_BODY_TIMEOUT_MS` at a trickle.
     */
    RECORDING_MIN_BYTES_PER_SECOND: integer(1, 100_000_000).default(32_768),

    /** The window the minimum rate is judged over, in milliseconds (a quiet sender is cut off after at most this long). */
    RECORDING_RATE_WINDOW_MS: integer(100, 600_000).default(60_000),

    /**
     * The secrets the callers of the internal routes may present, comma separated (ADR 0013): more
     * than one lets a secret be rotated without downtime. Each is 32 to 512 printable characters.
     * Required outside `local`, where the public local default is refused.
     */
    INTERNAL_API_TOKENS: z
      .string()
      .max(MAX_INTERNAL_TOKENS * (MAX_INTERNAL_TOKEN_LENGTH + 1))
      .optional(),

    /** The most queue messages handled at once by one instance. */
    CONSUMER_CONCURRENCY: integer(1, 100).default(4),
    /** How long shutdown lets in-flight messages finish before it gives them back to the queue. */
    CONSUMER_STOP_DEADLINE_MS: integer(1, 120_000).default(5_000),

    /**
     * Whether this instance runs the ingestion job loop (parse, chunk, embed, index). Off gives an
     * API-only instance: uploads stay `uploaded` and nothing claims them. The sweeps are
     * `SWEEPS_ENABLED`, not this. Defaults to true in
     * `local` and false elsewhere, and true is refused outside `local` while a pipeline port is a
     * fake ({@link PIPELINE_FAKE_PORTS}).
     */
    WORKERS_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    /**
     * Whether this instance runs Deal import jobs (parse a CSV, apply its rows). Independent of
     * `WORKERS_ENABLED`: an import uses no embedder, OCR or vector store, so it runs where the
     * document job loop is refused. Imports share the pool of `INGESTION_CONCURRENCY`.
     */
    IMPORTS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    /**
     * Whether this instance runs the sweeps: the purge, `cleanup_pending`, housekeeping and orphan
     * objects. On by default everywhere, and independent of `WORKERS_ENABLED`: without them
     * nothing is ever purged and the remove-all route never reaches 200.
     */
    SWEEPS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    /** Ingestion jobs one instance runs at once; it claims no more than this per round. */
    INGESTION_CONCURRENCY: integer(1, 16).default(2),
    /**
     * The most of the pool's slots one Organization may hold at once on an instance (Call jobs, document jobs
     * and imports are limited by it; a re-tag is counted but never held back), so one Organization's slow files cannot delay everyone else. Default:
     * one less than `INGESTION_CONCURRENCY`, at least 1; a value above the pool is the pool.
     */
    INGESTION_ORGANIZATION_CONCURRENCY: integer(1, 16).optional(),
    /** How long a claimed job is safe from another instance, in ms; a heartbeat renews it. */
    INGESTION_LEASE_MS: integer(5_000, 600_000).default(90_000),
    /** How often a running job renews its lease, in ms; at most a third of the lease. */
    INGESTION_HEARTBEAT_MS: integer(500, 120_000).default(15_000),
    /** The longest one call to the object store, the embedder or the vector store may take, in ms; at most half the lease. */
    INGESTION_IO_TIMEOUT_MS: integer(1_000, 120_000).default(30_000),
    /** The longest the embedder or the vector store may take to answer one search, in ms each; past it the search is a 504. */
    SEARCH_STEP_TIMEOUT_MS: integer(100, 10_000).default(1_500),
    /** The longest the parser or OCR may take for one document, in ms (the lease is renewed meanwhile). */
    INGESTION_PARSE_TIMEOUT_MS: integer(1_000, 600_000).default(180_000),
    /** How far the process's resident memory may grow while one document parses, in bytes; past it the parse is ended with `processing_failed`. */
    PARSER_MEMORY_LIMIT_BYTES: integer(134_217_728, 8_589_934_592).default(1_073_741_824),
    /** Claims of one job before the service fails it (the database's own bound is 20). */
    INGESTION_MAX_ATTEMPTS: integer(1, 19).default(8),
    /** The first retry delay of a failed attempt, in ms; it doubles per attempt up to ten minutes, with full jitter. */
    INGESTION_RETRY_BASE_MS: integer(100, 600_000).default(5_000),
    /** How long the job loop sleeps when it found nothing due, in ms, jittered by up to a quarter. */
    INGESTION_POLL_INTERVAL_MS: integer(100, 300_000).default(5_000),
    /** How often a transcribe job asks the vendor for its result, in ms, jittered by up to a quarter. */
    TRANSCRIBE_POLL_INTERVAL_MS: integer(100, 300_000).default(5_000),
    /** The longest one transcribe attempt waits for the vendor's result, in ms; past it the Call fails with `transcription_timed_out`. */
    TRANSCRIBE_MAX_WAIT_MS: integer(1_000, 21_600_000).default(3_600_000),
    /** The size a chunk is cut towards, in characters (about 250 tokens). */
    CHUNK_TARGET_CHARS: integer(200, 8_000).default(1_000),
    /** The size no chunk exceeds, in characters (about 400 tokens). */
    CHUNK_MAX_CHARS: integer(300, 16_000).default(1_600),
    /** The tail of a chunk repeated at the start of the next one of a long section, in characters. */
    CHUNK_OVERLAP_CHARS: integer(0, 2_000).default(150),
    /** The most chunks one document may produce; more fails the document with `processing_failed`. */
    MAX_CHUNKS_PER_DOCUMENT: integer(1, 100_000).default(5_000),
    /**
     * The most Moments one Call embeds (hub issue 76): a 5 MB Transcript can hold 10,000, and the
     * quota counts Calls, not embeds. The first and the last half of the cap are kept and the middle count is logged as skipped,
     * so the Call still ends `ready`.
     */
    MAX_MOMENTS_PER_CALL: integer(1, 10_000).default(2_000),
    /** The most rows an export file holds before the next file starts (a file also closes at 4 MiB). */
    EXPORT_ROWS_PER_FILE: integer(1, 10_000).default(1_000),
    /** The most text characters one document may hold after parsing; more fails it with `processing_failed`. */
    MAX_TEXT_CHARS_PER_DOCUMENT: integer(1_000, 20_000_000).default(5_000_000),
    /** Organizations one work-discovery page returns (1 to the database's batch maximum). */
    DISCOVERY_BATCH: integer(1, PLAYBOOK_MAX_BATCH).default(100),
    /** Documents one Organization's cleanup or purge pass takes at once. */
    SWEEP_BATCH: integer(1, PLAYBOOK_MAX_BATCH).default(20),
    /** Rows one consumed-message or idempotency purge statement removes (it repeats while full, a few times). */
    HOUSEKEEPING_BATCH: integer(1, PLAYBOOK_MAX_BATCH).default(200),
    /** Between two vector-cleanup and purge sweeps, in ms, jittered by up to a quarter. */
    SWEEP_INTERVAL_MS: integer(1_000, 3_600_000).default(30_000),
    /** Between two housekeeping sweeps (consumed messages, idempotency keys, orphan objects, spent purges), in ms, jittered. */
    HOUSEKEEPING_INTERVAL_MS: integer(1_000, 86_400_000).default(600_000),
    /** How long a purge claim is held while the vectors and files go, in ms. */
    PURGE_LEASE_MS: integer(5_000, 3_600_000).default(120_000),
    /** Objects one orphan-sweep listing page holds (1 to 1000). */
    ORPHAN_PAGE_SIZE: integer(1, 1_000).default(200),
    /** Listing pages the orphan sweep reads per Organization per pass. */
    ORPHAN_MAX_PAGES: integer(1, 1_000).default(25),
    /** How long one orphan-sweep page holds the Organization's sweep claim, in ms; a page must finish well inside it. */
    ORPHAN_CLAIM_MS: integer(ORPHAN_SWEEP_MIN_CLAIM_MS, ORPHAN_SWEEP_MAX_CLAIM_MS).default(120_000),
    /** The Moments one Organization may embed per UTC day; a Call over it waits for the next day. */
    EMBED_DAILY_MOMENTS_PER_ORGANIZATION: integer(1, EMBED_USAGE_MAX_MOMENTS).default(200_000),
    /** Days a Call may wait on the embed budget, from the job's creation, before it fails (1 to 90). */
    EMBED_DEFER_MAX_AGE_DAYS: integer(1, 90).default(14),
    /** Days of embed counts kept besides today before the purge removes them (1 to 365). */
    EMBED_USAGE_KEEP_DAYS: integer(1, 365).default(35),
    /** How long shutdown lets jobs and sweeps reach a step boundary before it moves on, in ms. */
    WORKERS_STOP_DEADLINE_MS: integer(1, 120_000).default(5_000),
  })
  .refine((env) => env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS <= MAX_SHUTDOWN_TOTAL_MS, {
    message: `SHUTDOWN_GRACE_MS plus SHUTDOWN_TIMEOUT_MS must not exceed ${MAX_SHUTDOWN_TOTAL_MS} ms in total`,
    path: ['SHUTDOWN_TIMEOUT_MS'],
  })
  .refine((env) => env.CONSUMER_STOP_DEADLINE_MS <= env.SHUTDOWN_TIMEOUT_MS, {
    message: 'CONSUMER_STOP_DEADLINE_MS must not exceed SHUTDOWN_TIMEOUT_MS',
    path: ['CONSUMER_STOP_DEADLINE_MS'],
  })
  .refine((env) => env.INGESTION_HEARTBEAT_MS * 3 <= env.INGESTION_LEASE_MS, {
    message: 'INGESTION_HEARTBEAT_MS must be at most a third of INGESTION_LEASE_MS',
    path: ['INGESTION_HEARTBEAT_MS'],
  })
  .refine((env) => env.INGESTION_IO_TIMEOUT_MS * 2 <= env.INGESTION_LEASE_MS, {
    message: 'INGESTION_IO_TIMEOUT_MS must be at most half of INGESTION_LEASE_MS',
    path: ['INGESTION_IO_TIMEOUT_MS'],
  })
  .refine((env) => env.CHUNK_TARGET_CHARS <= env.CHUNK_MAX_CHARS, {
    message: 'CHUNK_TARGET_CHARS must not exceed CHUNK_MAX_CHARS',
    path: ['CHUNK_TARGET_CHARS'],
  })
  .refine((env) => env.CHUNK_OVERLAP_CHARS * 2 <= env.CHUNK_TARGET_CHARS, {
    message: 'CHUNK_OVERLAP_CHARS must be at most half of CHUNK_TARGET_CHARS',
    path: ['CHUNK_OVERLAP_CHARS'],
  })
  .refine((env) => env.CHUNK_TARGET_CHARS + env.CHUNK_OVERLAP_CHARS + 1 <= env.CHUNK_MAX_CHARS, {
    message: 'CHUNK_TARGET_CHARS plus CHUNK_OVERLAP_CHARS plus one must not exceed CHUNK_MAX_CHARS',
    path: ['CHUNK_MAX_CHARS'],
  })
  .refine((env) => env.WORKERS_STOP_DEADLINE_MS <= env.SHUTDOWN_TIMEOUT_MS, {
    message: 'WORKERS_STOP_DEADLINE_MS must not exceed SHUTDOWN_TIMEOUT_MS',
    path: ['WORKERS_STOP_DEADLINE_MS'],
  })
  .superRefine(requireSentryDsn)
  .superRefine((env, context) => {
    if (
      env.ENVIRONMENT !== 'local' &&
      env.WORKERS_ENABLED === true &&
      fakePortsOf(env).length > 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['WORKERS_ENABLED'],
        message: `WORKERS_ENABLED cannot be true outside local while these ports are fakes: ${fakePortsOf(env).join(', ')}`,
      })
    }
  })
  .superRefine((env, context) => {
    // Messages name the key and the rule, never the value: a URL can carry credentials.
    if (env.ENVIRONMENT !== 'local') {
      for (const key of REQUIRED_OUTSIDE_LOCAL) {
        if (env[key] === undefined) {
          context.addIssue({ code: 'custom', path: [key], message: `${key} is required` })
        }
      }
      for (const key of ['QUEUE_ENDPOINT', 'STORAGE_ENDPOINT'] as const) {
        if (env[key] !== undefined) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is accepted only when ENVIRONMENT is local`,
          })
        }
      }
    }
    if (env.INTERNAL_API_TOKENS !== undefined) {
      const entries = env.INTERNAL_API_TOKENS.split(',')
      // Messages name the position, never the secret.
      if (entries.length > MAX_INTERNAL_TOKENS) {
        context.addIssue({
          code: 'custom',
          path: ['INTERNAL_API_TOKENS'],
          message: `at most ${MAX_INTERNAL_TOKENS} secrets`,
        })
      }
      entries.forEach((entry, index) => {
        if (
          entry.length < MIN_INTERNAL_TOKEN_LENGTH ||
          entry.length > MAX_INTERNAL_TOKEN_LENGTH ||
          !PRINTABLE_ASCII.test(entry)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['INTERNAL_API_TOKENS'],
            message: `secret ${index + 1} must be ${MIN_INTERNAL_TOKEN_LENGTH} to ${MAX_INTERNAL_TOKEN_LENGTH} characters, with no empty entry or spaces`,
          })
        }
        if (env.ENVIRONMENT !== 'local' && entry === LOCAL_INTERNAL_API_TOKEN) {
          context.addIssue({
            code: 'custom',
            path: ['INTERNAL_API_TOKENS'],
            message: `secret ${index + 1} is the public local default, which is accepted only when ENVIRONMENT is local`,
          })
        }
      })
    }
    if (env.QUEUE_ENDPOINT !== undefined && env.QUEUE_URL === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['QUEUE_ENDPOINT'],
        message: 'QUEUE_ENDPOINT needs QUEUE_URL',
      })
    }
    if (env.STORAGE_ENDPOINT !== undefined && env.STORAGE_BUCKET === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['STORAGE_ENDPOINT'],
        message: 'STORAGE_ENDPOINT needs STORAGE_BUCKET',
      })
    }
  })
  .transform((env) => ({
    ...env,
    WORKERS_ENABLED: env.WORKERS_ENABLED ?? env.ENVIRONMENT === 'local',
    INGESTION_ORGANIZATION_CONCURRENCY: Math.min(
      env.INGESTION_CONCURRENCY,
      env.INGESTION_ORGANIZATION_CONCURRENCY ?? Math.max(1, env.INGESTION_CONCURRENCY - 1)
    ),
    REGION: env.REGION ?? regionSchema.parse('us'),
    DATABASE_URL: env.DATABASE_URL ?? LOCAL_DATABASE_URL,
    AUTH_JWKS_URL: env.AUTH_JWKS_URL ?? `${LOCAL_AUTH_ORIGIN}/.well-known/jwks.json`,
    AUTH_ISSUER: env.AUTH_ISSUER ?? LOCAL_AUTH_ORIGIN,
    AUTH_AUDIENCE: env.AUTH_AUDIENCE ?? DEFAULT_AUTH_AUDIENCE,
    AWS_REGION: env.AWS_REGION ?? LOCAL_AWS_REGION,
    MAX_UPLOAD_BYTES: env.MAX_UPLOAD_BYTES ?? MAX_DOCUMENT_BYTES,
    MAX_PAGES_PER_DOCUMENT: env.MAX_PAGES_PER_DOCUMENT ?? MAX_DOCUMENT_PAGES,
    INTERNAL_API_TOKENS: (env.INTERNAL_API_TOKENS?.split(',') ??
      (env.ENVIRONMENT === 'local' ? [LOCAL_INTERNAL_API_TOKEN] : [])) as readonly string[],
  }))

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/** Parse configuration from the given variables, failing fast on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}
