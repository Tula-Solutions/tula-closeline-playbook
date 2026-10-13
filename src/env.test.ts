import { describe, expect, test } from 'bun:test'
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_PAGES } from 'tula-closeline-contract'
import { LOCAL_INTERNAL_API_TOKEN, loadEnv, MAX_CONCURRENT_UPLOADS_LIMIT } from './env'

/** Every key that has no default outside `local`, set to a valid value. */
const DEPLOYED: Record<string, string> = {
  REGION: 'eu',
  SENTRY_DSN: 'https://public@o1.ingest.de.sentry.io/1',
  DATABASE_URL: 'postgres://closeline_playbook:secret@db.internal:5432/closeline',
  AUTH_JWKS_URL: 'https://auth.example.test/.well-known/jwks.json',
  AUTH_ISSUER: 'https://auth.example.test',
  AUTH_AUDIENCE: 'closeline',
  AWS_REGION: 'eu-west-1',
  QUEUE_URL: 'https://sqs.eu-west-1.amazonaws.com/123456789012/playbook',
  STORAGE_BUCKET: 'closeline-playbook-eu',
  INTERNAL_API_TOKENS: 'a-deployed-secret-of-at-least-32-characters',
}

describe('local defaults', () => {
  test('a local process boots on the environment alone, with the contract limits and local services', () => {
    const env = loadEnv({ ENVIRONMENT: 'local' })

    expect(env).toMatchObject({
      ENVIRONMENT: 'local',
      PORT: 3000,
      LOG_LEVEL: 'info',
      READINESS_TIMEOUT_MS: 2_000,
      SHUTDOWN_TIMEOUT_MS: 10_000,
      SHUTDOWN_GRACE_MS: 5_000,
      MAX_REQUEST_BODY_BYTES: 1_048_576,
      REGION: 'us',
      MAX_UPLOAD_BYTES: MAX_DOCUMENT_BYTES,
      MAX_PAGES_PER_DOCUMENT: MAX_DOCUMENT_PAGES,
      MAX_CONCURRENT_UPLOADS: 4,
      UPLOAD_BODY_TIMEOUT_MS: 60_000,
      CONSUMER_CONCURRENCY: 4,
      CONSUMER_STOP_DEADLINE_MS: 5_000,
    })
    expect(env.DATABASE_URL).toContain('127.0.0.1')
    expect(env.QUEUE_URL).toBeUndefined()
    expect(env.STORAGE_BUCKET).toBeUndefined()
    expect(env.SENTRY_DSN).toBeUndefined()
  })

  test('a deploy without ENVIRONMENT fails at boot instead of running as local', () => {
    expect(() => loadEnv({})).toThrow()
  })
})

describe('outside local', () => {
  test.each(['dev', 'staging', 'prod'])('%s accepts a complete configuration', (environment) => {
    const env = loadEnv({ ...DEPLOYED, ENVIRONMENT: environment })

    expect(env.ENVIRONMENT).toBe(environment)
    expect(env.REGION).toBe('eu')
    expect(env.QUEUE_URL).toBe(DEPLOYED.QUEUE_URL)
  })

  test.each(Object.keys(DEPLOYED))('%s is required', (key) => {
    const { [key]: _removed, ...rest } = DEPLOYED

    expect(() => loadEnv({ ...rest, ENVIRONMENT: 'prod' })).toThrow(new RegExp(key))
  })

  test('the first error names the key and never repeats a value', () => {
    let message = ''
    try {
      loadEnv({ ...DEPLOYED, ENVIRONMENT: 'prod', DATABASE_URL: 'mysql://user:hunter2@db/x' })
    } catch (error) {
      message = String(error)
    }

    expect(message).toContain('DATABASE_URL')
    expect(message).not.toContain('hunter2')
  })

  test.each(['QUEUE_ENDPOINT', 'STORAGE_ENDPOINT'])('%s is accepted only in local', (key) => {
    expect(() =>
      loadEnv({ ...DEPLOYED, ENVIRONMENT: 'prod', [key]: 'http://127.0.0.1:9324' })
    ).toThrow(new RegExp(key))
  })
})

describe('adapters and endpoints', () => {
  test('a local process may point the queue and the store at their local stand-ins', () => {
    const env = loadEnv({
      ENVIRONMENT: 'local',
      QUEUE_URL: 'http://127.0.0.1:9324/000000000000/playbook',
      QUEUE_ENDPOINT: 'http://127.0.0.1:9324',
      STORAGE_BUCKET: 'closeline-dev',
      STORAGE_ENDPOINT: 'http://127.0.0.1:9090',
    })

    expect(env.QUEUE_ENDPOINT).toBe('http://127.0.0.1:9324')
    expect(env.STORAGE_ENDPOINT).toBe('http://127.0.0.1:9090')
  })

  test('an endpoint without the queue or bucket it belongs to is refused', () => {
    expect(() =>
      loadEnv({ ENVIRONMENT: 'local', QUEUE_ENDPOINT: 'http://127.0.0.1:9324' })
    ).toThrow(/QUEUE_ENDPOINT/)
    expect(() =>
      loadEnv({ ENVIRONMENT: 'local', STORAGE_ENDPOINT: 'http://127.0.0.1:9090' })
    ).toThrow(/STORAGE_ENDPOINT/)
  })

  test('a bucket name that is not a bucket name is refused', () => {
    expect(() => loadEnv({ ENVIRONMENT: 'local', STORAGE_BUCKET: 'Has Spaces' })).toThrow(
      /STORAGE_BUCKET/
    )
  })
})

describe('upload limits', () => {
  test('may be lowered below the contract limits', () => {
    const env = loadEnv({
      ENVIRONMENT: 'local',
      MAX_UPLOAD_BYTES: '1000',
      MAX_PAGES_PER_DOCUMENT: '10',
      MAX_CONCURRENT_UPLOADS: '2',
    })

    expect(env).toMatchObject({
      MAX_UPLOAD_BYTES: 1000,
      MAX_PAGES_PER_DOCUMENT: 10,
      MAX_CONCURRENT_UPLOADS: 2,
    })
  })

  test.each([
    ['a file size above the contract limit', { MAX_UPLOAD_BYTES: String(MAX_DOCUMENT_BYTES + 1) }],
    [
      'a page count above the contract limit',
      { MAX_PAGES_PER_DOCUMENT: String(MAX_DOCUMENT_PAGES + 1) },
    ],
    ['no concurrent uploads', { MAX_CONCURRENT_UPLOADS: '0' }],
    [
      'more concurrent uploads than an instance can hold',
      { MAX_CONCURRENT_UPLOADS: String(MAX_CONCURRENT_UPLOADS_LIMIT + 1) },
    ],
    ['a zero file size', { MAX_UPLOAD_BYTES: '0' }],
    ['an upload body timeout under 100 ms', { UPLOAD_BODY_TIMEOUT_MS: '99' }],
    ['an upload body timeout over ten minutes', { UPLOAD_BODY_TIMEOUT_MS: '600001' }],
  ])('%s is refused at boot', (_name, source) => {
    expect(() => loadEnv({ ENVIRONMENT: 'local', ...source })).toThrow()
  })
})

describe('shared bounds', () => {
  test.each([
    ['an unknown environment', { ENVIRONMENT: 'production' }],
    ['an unknown log level', { LOG_LEVEL: 'verbose' }],
    ['a port out of range', { PORT: '70000' }],
    ['a zero readiness timeout', { READINESS_TIMEOUT_MS: '0' }],
    ['a non-numeric shutdown timeout', { SHUTDOWN_TIMEOUT_MS: 'soon' }],
    ['a negative shutdown grace', { SHUTDOWN_GRACE_MS: '-1' }],
    ['a zero body limit', { MAX_REQUEST_BODY_BYTES: '0' }],
    ['a body limit above 100 MB', { MAX_REQUEST_BODY_BYTES: '104857601' }],
    ['a region that is not a Region', { REGION: 'moon' }],
    ['zero consumer concurrency', { CONSUMER_CONCURRENCY: '0' }],
    ['a Sentry DSN that is not one', { SENTRY_DSN: 'not-a-dsn' }],
  ])('configuration rejects %s at boot', (_name, source) => {
    expect(() => loadEnv({ ENVIRONMENT: 'local', ...source })).toThrow()
  })

  test('a grace period plus drain timeout above 60 s is rejected, naming both keys', () => {
    const source = {
      ENVIRONMENT: 'local',
      SHUTDOWN_GRACE_MS: '30001',
      SHUTDOWN_TIMEOUT_MS: '30000',
    }

    expect(() => loadEnv(source)).toThrow(/SHUTDOWN_GRACE_MS.*SHUTDOWN_TIMEOUT_MS/s)
  })

  test('a grace period plus drain timeout of exactly 60 s is accepted', () => {
    const env = loadEnv({
      ENVIRONMENT: 'local',
      SHUTDOWN_GRACE_MS: '30000',
      SHUTDOWN_TIMEOUT_MS: '30000',
    })

    expect(env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS).toBe(60_000)
  })

  test('the consumer may not be given longer to stop than the whole drain', () => {
    expect(() =>
      loadEnv({
        ENVIRONMENT: 'local',
        SHUTDOWN_TIMEOUT_MS: '3000',
        CONSUMER_STOP_DEADLINE_MS: '3001',
      })
    ).toThrow(/CONSUMER_STOP_DEADLINE_MS/)
  })
})

describe('numbers are whole numbers written in digits', () => {
  const NUMERIC = [
    'PORT',
    'READINESS_TIMEOUT_MS',
    'SHUTDOWN_TIMEOUT_MS',
    'SHUTDOWN_GRACE_MS',
    'MAX_REQUEST_BODY_BYTES',
    'MAX_UPLOAD_BYTES',
    'MAX_PAGES_PER_DOCUMENT',
    'MAX_CONCURRENT_UPLOADS',
    'UPLOAD_BODY_TIMEOUT_MS',
    'CONSUMER_CONCURRENCY',
    'CONSUMER_STOP_DEADLINE_MS',
  ]
  const BAD = ['', ' 5', '5 ', '0x10', '1e1', '-1', '1.5', '+5', '5\n', 'Infinity', 'NaN', '٣']

  for (const key of NUMERIC) {
    test.each(BAD)(`${key} rejects %j, naming the key and not the value`, (value) => {
      let message = ''
      try {
        loadEnv({ ENVIRONMENT: 'local', [key]: value })
      } catch (error) {
        message = String(error)
      }

      expect(message).toContain(key)
      // Plain digits would match numbers in the rule text; the odd spellings cannot.
      if (/[a-z.]/i.test(value)) {
        expect(message).not.toContain(value)
      }
    })
  }

  test('plain digits are accepted, leading zeros included', () => {
    expect(loadEnv({ ENVIRONMENT: 'local', PORT: '08080' }).PORT).toBe(8080)
  })

  test('a number too long to be exact is refused', () => {
    expect(() => loadEnv({ ENVIRONMENT: 'local', MAX_UPLOAD_BYTES: '9'.repeat(30) })).toThrow(
      /MAX_UPLOAD_BYTES/
    )
  })
})

describe('internal API secrets', () => {
  const SECRET_A = 'a-deployed-secret-of-at-least-32-characters'
  const SECRET_B = 'the-next-secret-of-at-least-32-characters-x'

  test('a local process falls back to the public local secret', () => {
    expect(loadEnv({ ENVIRONMENT: 'local' }).INTERNAL_API_TOKENS).toEqual([
      LOCAL_INTERNAL_API_TOKEN,
    ])
  })

  test('the public local secret is refused outside local, and the message does not repeat it', () => {
    const attempt = () =>
      loadEnv({ ...DEPLOYED, ENVIRONMENT: 'prod', INTERNAL_API_TOKENS: LOCAL_INTERNAL_API_TOKEN })

    expect(attempt).toThrow(/INTERNAL_API_TOKENS/)
    try {
      attempt()
    } catch (error) {
      expect(String(error)).not.toContain(LOCAL_INTERNAL_API_TOKEN)
    }
  })

  test('two secrets are a rotation, in order', () => {
    const env = loadEnv({
      ...DEPLOYED,
      ENVIRONMENT: 'prod',
      INTERNAL_API_TOKENS: `${SECRET_A},${SECRET_B}`,
    })

    expect(env.INTERNAL_API_TOKENS).toEqual([SECRET_A, SECRET_B])
  })

  test.each([
    ['too short', 'short'],
    ['an empty entry', `${SECRET_A},`],
    ['a space', `${SECRET_A} x`],
    ['more than five', Array.from({ length: 6 }, (_, i) => `${SECRET_A}-${i}`).join(',')],
  ])('a list with %s is refused', (_label, value) => {
    expect(() => loadEnv({ ...DEPLOYED, ENVIRONMENT: 'prod', INTERNAL_API_TOKENS: value })).toThrow(
      /INTERNAL_API_TOKENS/
    )
  })
})

describe('quotas', () => {
  test('default to the contract numbers and may be lowered by configuration', () => {
    const env = loadEnv({ ENVIRONMENT: 'local' })
    expect(env.MAX_DOCUMENTS_PER_ORGANIZATION).toBe(500)
    expect(env.MAX_BYTES_PER_ORGANIZATION).toBe(2 * 1024 * 1024 * 1024)
    expect(
      loadEnv({ ENVIRONMENT: 'local', MAX_DOCUMENTS_PER_ORGANIZATION: '2' })
        .MAX_DOCUMENTS_PER_ORGANIZATION
    ).toBe(2)
  })
})
