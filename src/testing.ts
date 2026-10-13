import type { OpenAPIHono } from '@hono/zod-openapi'
import { formatId, type OrganizationId, type Role, type UserId } from 'tula-closeline-contract'
import {
  createLogger,
  createMemoryProcessedStore,
  createStaticKeySet,
  createTokenVerifier,
  type FixedClock,
  TokenVerificationError,
  type TokenVerifier,
} from 'tula-closeline-kit'
import type { Handlers } from 'tula-closeline-kit/queue'
import {
  createMemoryErrorReporter,
  createMemoryObjectStore,
  createMemoryQueue,
  createMemoryVectorStore,
  createTestJwks,
  createTestKeyPair,
  createVirtualTime,
  type MemoryErrorReporter,
  type MemoryQueue,
  type MintTokenOptions,
  mintTestToken,
  type VirtualTime,
} from 'tula-closeline-kit/testing'
import { createMemoryEmbedder, type MemoryEmbedder } from '~/adapters/memory/embedder'
import { createMemoryOcrReader } from '~/adapters/memory/ocr'
import { createMemoryParser } from '~/adapters/memory/parser'
import {
  createMemoryPlaybookDatabase,
  type MemoryPlaybookDatabase,
} from '~/adapters/memory/playbook-database'
import type { InScope } from '~/adapters/postgres/processed-store'
import { createApp } from '~/app'
import { createPlaybookConsumer } from '~/consumer'
import type { Container, ErrorContext, ReadinessCheck } from '~/container'
import { loadEnv } from '~/env'
import type { AppEnv } from '~/http/types'
import { SERVICE } from '~/info'
import { type PlaybookDefinition, type PlaybookEnvelope, registry } from '~/messages'

/** The issuer and audience the test environment's tokens carry. */
const TEST_ISSUER = 'https://auth.test'
const TEST_AUDIENCE = 'closeline'

/** The internal secret the test environment accepts; fine for any `ENVIRONMENT`. */
export const TEST_INTERNAL_SECRET = 'test-internal-secret-of-at-least-32-characters'

/** The container plus the observable side effects a test asserts on. */
export type TestDeps = Container & {
  clock: FixedClock
  /** Time that moves only when a test advances it; the queue, store and consumer share it. */
  time: VirtualTime
  queue: MemoryQueue<PlaybookDefinition>
  embedder: MemoryEmbedder
  /** The database double behind `scope`: it runs the db library's statements in memory. */
  database: MemoryPlaybookDatabase
  /** The kit's memory error reporter: what the consumer and the error handler would send to Sentry. */
  errors: MemoryErrorReporter
  /** Every JSON log line written, in order. */
  logLines: string[]
  /** Every call to `reportError`, in order. */
  reported: { error: unknown; context: ErrorContext }[]
}

/** What a test may replace in {@link createTestDeps}. */
export type TestDepsOverrides = {
  readinessChecks?: readonly ReadinessCheck[]
  env?: Record<string, string>
  /** The access-token verifier; defaults to one that rejects every token. */
  tokenVerifier?: TokenVerifier
  /** The Organization-scoped statement runner; defaults to the in-memory database double. */
  scope?: InScope
  /** The queue handlers; default none, as in the service today. */
  handlers?: Handlers<PlaybookEnvelope>
  /** Messages handled at once; defaults to the environment's setting. */
  consumerConcurrency?: number
}

const REJECTING_VERIFIER: TokenVerifier = {
  verify: async () => {
    throw new TokenVerificationError('invalid')
  },
}

/** Builds a container of in-memory doubles and virtual time; `overrides` replace any field. */
export function createTestDeps(overrides: TestDepsOverrides = {}): TestDeps {
  const logLines: string[] = []
  const reported: TestDeps['reported'] = []
  const time = createVirtualTime()
  const errors = createMemoryErrorReporter()
  const logger = createLogger({
    service: SERVICE,
    level: 'debug',
    destination: { write: (line) => void logLines.push(line) },
  })
  const env = loadEnv({
    ENVIRONMENT: 'local',
    LOG_LEVEL: 'debug',
    // Every key that is required outside local, so a test may set any ENVIRONMENT.
    REGION: 'us',
    SENTRY_DSN: 'https://public@sentry.test/1',
    DATABASE_URL: 'postgres://closeline_playbook:closeline_playbook_local@127.0.0.1:5432/closeline',
    AUTH_JWKS_URL: `${TEST_ISSUER}/.well-known/jwks.json`,
    AUTH_ISSUER: TEST_ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    AWS_REGION: 'us-east-1',
    QUEUE_URL: 'https://sqs.test/000000000000/playbook',
    STORAGE_BUCKET: 'playbook-test',
    INTERNAL_API_TOKENS: TEST_INTERNAL_SECRET,
    ...overrides.env,
  })
  const queue = createMemoryQueue({ registry, clock: time.clock, sleep: time.sleep })
  const embedder = createMemoryEmbedder({ dimensions: 64 })
  const processed = createMemoryProcessedStore({ clock: time.clock })
  const database = createMemoryPlaybookDatabase({ clock: time.clock })

  return {
    env,
    logger,
    clock: time.clock,
    time,
    tokenVerifier: overrides.tokenVerifier ?? REJECTING_VERIFIER,
    withOrganization: () => {
      throw new Error('this test container has no database; use the integration harness')
    },
    scope: overrides.scope ?? database.scope,
    database,
    queue,
    objects: createMemoryObjectStore({ clock: time.clock }),
    vectors: createMemoryVectorStore({ dimensions: embedder.dimensions }),
    processed,
    embedder,
    parser: createMemoryParser(),
    ocr: createMemoryOcrReader(),
    consumer: createPlaybookConsumer({
      queue,
      store: processed,
      logger,
      errorReporter: errors,
      handlers: overrides.handlers ?? {},
      concurrency: overrides.consumerConcurrency ?? env.CONSUMER_CONCURRENCY,
      sleep: time.sleep,
    }),
    readinessChecks: overrides.readinessChecks ?? [],
    lifecycle: { draining: false },
    reportError: (error, context) => {
      reported.push({ error, context })
    },
    close: async () => undefined,
    errors,
    logLines,
    reported,
  }
}

/** Who a minted access token names. */
export type TestIdentity = { userId: UserId; organizationId: OrganizationId; role: Role }

/** A fresh user id, for a test that needs one nobody else has. */
export function newUserId(): UserId {
  return formatId('usr', crypto.randomUUID())
}

/** A fresh Organization id. */
export function newOrganizationId(): OrganizationId {
  return formatId('org', crypto.randomUUID())
}

/** The app, its container, and what a test needs to call it as someone. */
export type TestApp = {
  app: OpenAPIHono<AppEnv>
  deps: TestDeps
  /** The `Authorization` header of a valid access token for `identity`. */
  bearer(identity: TestIdentity): Promise<{ authorization: string }>
  /** A token signed by a key the service does not trust, for `identity`. */
  bearerFromUnknownKey(identity: TestIdentity): Promise<{ authorization: string }>
  /** A token signed by the trusted key with `claims` or an `audience` or `issuer` overridden. */
  bearerWith(
    identity: TestIdentity,
    options: Pick<MintTokenOptions, 'audience' | 'issuer' | 'claims'>
  ): Promise<{ authorization: string }>
}

/**
 * The whole app over a fresh container, with a verifier that accepts the tokens `bearer` signs
 * (a real Ed25519 key pair, verified the way production verifies) and nothing else.
 */
export async function createTestApp(overrides: TestDepsOverrides = {}): Promise<TestApp> {
  const keyPair = await createTestKeyPair()
  const strangerKeyPair = await createTestKeyPair('stranger')
  // The verifier and the minted tokens read the deps' clock, whatever a test advances it to.
  const holder: { deps?: TestDeps } = {}
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    keys: await createStaticKeySet(createTestJwks(keyPair)),
    clock: { now: () => holder.deps?.clock.now() ?? new Date('2026-01-01T00:00:00Z') },
  })
  const deps = createTestDeps({ tokenVerifier: verifier, ...overrides })
  holder.deps = deps
  const mint = async (
    pair: typeof keyPair,
    identity: TestIdentity,
    options: Pick<MintTokenOptions, 'audience' | 'issuer' | 'claims'> = {}
  ) => ({
    authorization: `Bearer ${await mintTestToken({
      keyPair: pair,
      clock: deps.clock,
      ...options,
      claims: {
        sub: identity.userId,
        org: identity.organizationId,
        role: identity.role,
        ...options.claims,
      },
    })}`,
  })

  return {
    app: createApp(deps),
    deps,
    bearer: (identity) => mint(keyPair, identity),
    bearerFromUnknownKey: (identity) => mint(strangerKeyPair, identity),
    bearerWith: (identity, options) => mint(keyPair, identity, options),
  }
}
