import { expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createContainer, reportSafely } from './container'
import { loadEnv } from './env'

/** The log lines of unhandled errors; the boot lines of the error reporter are not among them. */
const failures = (lines: string[]) => lines.filter((line) => line.includes('"unhandled error"'))

test('the default reportError logs the failure with its request context at error level', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'a'.repeat(32)}` as never

  container.reportError(new Error('disk on fire'), {
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
  })

  expect(failures(lines)).toHaveLength(1)
  expect(JSON.parse(failures(lines)[0] ?? '{}')).toMatchObject({
    level: 50, // error
    msg: 'unhandled error',
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
    error: { name: 'Error', message: 'disk on fire' },
  })
})

test('the default reportError logs the stack frames and the whole cause chain', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'c'.repeat(32)}` as never
  const error = new Error('query failed', { cause: new TypeError('socket closed') })

  container.reportError(error, { requestId, method: 'GET', path: '/x', status: 500 })

  const logged = JSON.parse(failures(lines)[0] ?? '{}')
  expect(logged.error.stack.length).toBeGreaterThan(0)
  expect(logged.error.cause).toMatchObject({ name: 'TypeError', message: 'socket closed' })
})

test('the default reportError bounds a long message', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'d'.repeat(32)}` as never

  container.reportError(new Error('z'.repeat(50_000)), {
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
  })

  expect((failures(lines)[0] ?? '').length).toBeLessThan(5_000)
})

test('reportSafely swallows a reporter that throws or rejects', async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', listener)
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))
  const context = {
    requestId: `req_${'e'.repeat(32)}` as never,
    method: 'GET',
    path: '/x',
    status: 500,
  }

  try {
    container.reportError = () => {
      throw new Error('sync failure')
    }
    reportSafely(container, new Error('a'), context)
    container.reportError = (async () => {
      throw new Error('async failure')
    }) as never
    reportSafely(container, new Error('b'), context)
    await Bun.sleep(20)

    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('the default reportError records a thrown non-Error without its value', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'b'.repeat(32)}` as never

  container.reportError('password=hunter2', { requestId, method: 'GET', path: '/x', status: 500 })

  expect(failures(lines)[0]).not.toContain('hunter2')
})

test('LOG_LEVEL silences the logger', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }), {
    logDestination: { write: (l) => lines.push(l) },
  })

  container.logger.error('nothing to see')

  expect(lines).toHaveLength(0)
})

test('a local container probes the database for readiness', () => {
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))

  expect(container.readinessChecks.map((check) => check.name)).toEqual(['database'])
})

test('a local container without settings runs on the memory queue and the memory object store', async () => {
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))
  const organizationId = formatId('org', crypto.randomUUID())

  expect('deadLetters' in container.queue).toBe(true)
  await container.objects.put(organizationId, 'a/b.txt', new Uint8Array([1, 2, 3]))
  expect((await container.objects.get(organizationId, 'a/b.txt'))?.body).toEqual(
    new Uint8Array([1, 2, 3])
  )
})

test('the vector store is memory-only, sized to the embedder', async () => {
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))
  const organizationId = formatId('org', crypto.randomUUID())
  const [vector] = await container.embedder.embed(['hello'], {
    purpose: 'document',
    signal: new AbortController().signal,
  })

  await container.vectors.upsert(organizationId, [{ id: 'd1:0', vector: vector ?? [] }])

  expect(await container.vectors.search(organizationId, { vector: vector ?? [], topK: 1 })).toEqual(
    [expect.objectContaining({ id: 'd1:0' })]
  )
})

test('QUEUE_URL switches the queue to the real adapter', () => {
  const container = createContainer(
    loadEnv({
      ENVIRONMENT: 'local',
      LOG_LEVEL: 'silent',
      QUEUE_URL: 'http://127.0.0.1:1/000000000000/playbook',
      QUEUE_ENDPOINT: 'http://127.0.0.1:1',
    })
  )

  expect('deadLetters' in container.queue).toBe(false)
})

test('STORAGE_BUCKET switches the object store to S3, reached at the configured endpoint', async () => {
  const requests: string[] = []
  const stand = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      return new Response(null, { status: 404 })
    },
  })
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY }
  process.env.AWS_ACCESS_KEY_ID = 'local'
  process.env.AWS_SECRET_ACCESS_KEY = 'local'
  try {
    const container = createContainer(
      loadEnv({
        ENVIRONMENT: 'local',
        LOG_LEVEL: 'silent',
        STORAGE_BUCKET: 'playbook-test',
        STORAGE_ENDPOINT: `http://127.0.0.1:${stand.port}`,
      })
    )

    const found = await container.objects.head(formatId('org', crypto.randomUUID()), 'a/b.txt')

    expect(found).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toStartWith('HEAD /playbook-test/')
  } finally {
    await stand.stop(true)
    for (const [name, value] of [
      ['AWS_ACCESS_KEY_ID', saved.id],
      ['AWS_SECRET_ACCESS_KEY', saved.secret],
    ] as const) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
})

test('the container builds the workers, the unscoped discovery call and real time for them', async () => {
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))

  expect(typeof container.discover).toBe('function')
  expect(typeof container.workers.start).toBe('function')
  expect(typeof container.workers.ingestion.nudge).toBe('function')
  expect(container.random()).toBeLessThan(1)
  await container.close()
})

test('closing the container twice is harmless', async () => {
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))

  await container.close()
  await container.close()
})

const DEPLOYED = {
  ENVIRONMENT: 'prod',
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

const fakeWarnings = (lines: string[]) =>
  lines.map((line) => JSON.parse(line)).filter((entry) => entry.msg === 'ports still on fakes')

test('outside local, one warning names every port still on a memory fake, and nothing else', async () => {
  const lines: string[] = []
  const container = createContainer(loadEnv(DEPLOYED), {
    logDestination: { write: (l) => lines.push(l) },
  })

  try {
    const warnings = fakeWarnings(lines)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      level: 40, // warn
      ports: ['embedder', 'ocr', 'vector store'],
    })
    expect(Object.keys(warnings[0]).sort()).toEqual(['level', 'msg', 'ports', 'service', 'time'])
  } finally {
    await container.close()
  }
})

test('a local container does not warn about its fakes', () => {
  const lines: string[] = []
  createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })

  expect(fakeWarnings(lines)).toEqual([])
})
