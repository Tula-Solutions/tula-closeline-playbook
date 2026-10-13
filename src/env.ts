import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PAGES, regionSchema } from 'tula-closeline-contract'
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

/** The keys that must be set in every environment but `local`, where they have defaults. */
const REQUIRED_OUTSIDE_LOCAL = [
  'REGION',
  'DATABASE_URL',
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'AUTH_AUDIENCE',
  'AWS_REGION',
  'QUEUE_URL',
  'STORAGE_BUCKET',
] as const

const schema = z
  .object({
    /** Which deployment this is. No default: a deploy that forgets it must fail at boot. */
    ENVIRONMENT: environmentSchema,
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    /** The longest one readiness check may take before it counts as failed. */
    READINESS_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
    /** The longest shutdown waits for in-flight requests before closing them. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
    /** How long `/readyz` reports 503 before the server stops accepting, so the balancer moves on. */
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
    /** The largest request body accepted, in bytes; anything bigger is a 413. */
    MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1).max(104_857_600).default(1_048_576),

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
    /** The ingestion queue's URL. Unset in `local` means the in-memory queue; required elsewhere. */
    QUEUE_URL: z.url().max(2_048).optional(),
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
    MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).max(MAX_DOCUMENT_BYTES).optional(),
    /** The most pages a document may have. May lower the contract's limit, never raise it. */
    MAX_PAGES_PER_DOCUMENT: z.coerce.number().int().min(1).max(MAX_DOCUMENT_PAGES).optional(),
    /**
     * The most uploads one instance handles at once. Each is held whole in memory (ADR 0016), so
     * this times `MAX_UPLOAD_BYTES` is the upload memory an instance may need.
     */
    MAX_CONCURRENT_UPLOADS: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_CONCURRENT_UPLOADS_LIMIT)
      .default(4),

    /** The most queue messages handled at once by one instance. */
    CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    /** How long shutdown lets in-flight messages finish before it gives them back to the queue. */
    CONSUMER_STOP_DEADLINE_MS: z.coerce.number().int().min(1).max(120_000).default(5_000),
  })
  .refine((env) => env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS <= MAX_SHUTDOWN_TOTAL_MS, {
    message: `SHUTDOWN_GRACE_MS plus SHUTDOWN_TIMEOUT_MS must not exceed ${MAX_SHUTDOWN_TOTAL_MS} ms in total`,
    path: ['SHUTDOWN_TIMEOUT_MS'],
  })
  .refine((env) => env.CONSUMER_STOP_DEADLINE_MS <= env.SHUTDOWN_TIMEOUT_MS, {
    message: 'CONSUMER_STOP_DEADLINE_MS must not exceed SHUTDOWN_TIMEOUT_MS',
    path: ['CONSUMER_STOP_DEADLINE_MS'],
  })
  .superRefine(requireSentryDsn)
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
    REGION: env.REGION ?? regionSchema.parse('us'),
    DATABASE_URL: env.DATABASE_URL ?? LOCAL_DATABASE_URL,
    AUTH_JWKS_URL: env.AUTH_JWKS_URL ?? `${LOCAL_AUTH_ORIGIN}/.well-known/jwks.json`,
    AUTH_ISSUER: env.AUTH_ISSUER ?? LOCAL_AUTH_ORIGIN,
    AUTH_AUDIENCE: env.AUTH_AUDIENCE ?? DEFAULT_AUTH_AUDIENCE,
    AWS_REGION: env.AWS_REGION ?? LOCAL_AWS_REGION,
    MAX_UPLOAD_BYTES: env.MAX_UPLOAD_BYTES ?? MAX_DOCUMENT_BYTES,
    MAX_PAGES_PER_DOCUMENT: env.MAX_PAGES_PER_DOCUMENT ?? MAX_DOCUMENT_PAGES,
  }))

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/** Parse configuration from the given variables, failing fast on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}
