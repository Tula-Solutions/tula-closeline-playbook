import { expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createFixedClock } from 'tula-closeline-kit'
import { createApp } from './app'
import { registry } from './messages'
import { drain, type Stoppable, shutdown, stoppableWith } from './shutdown'
import { createTestDeps, newOrganizationId } from './testing'

function fakeServer(finishesAfterMs: number | null) {
  const calls: (boolean | undefined)[] = []
  return {
    calls,
    stop: (force?: boolean) => {
      calls.push(force)
      if (force || finishesAfterMs === 0) {
        return Promise.resolve()
      }
      // A stuck request: graceful stop never settles unless it is allowed to finish.
      return finishesAfterMs === null
        ? new Promise<void>(() => {})
        : new Promise<void>((resolve) => setTimeout(resolve, finishesAfterMs))
    },
  }
}

test('drain waits for in-flight requests and does not force-close when they finish in time', async () => {
  const server = fakeServer(10)

  expect(await drain(server, 1_000)).toBe('drained')
  expect(server.calls).toEqual([undefined])
})

test('drain force-closes what is still running after the timeout', async () => {
  const server = fakeServer(null)

  expect(await drain(server, 20)).toBe('forced')
  expect(server.calls).toEqual([undefined, true])
})

function harness(options: { graceMs: number; stop: Stoppable['stop'] }) {
  const lifecycle: { draining: boolean; drainingSince?: number } = { draining: false }
  const clock = createFixedClock('2026-01-01T00:00:00Z')
  const exits: number[] = []
  const logs: string[] = []
  const run = () =>
    shutdown({
      signal: 'SIGTERM',
      server: { stop: options.stop },
      lifecycle,
      clock,
      logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
      graceMs: options.graceMs,
      timeoutMs: 50,
      exit: (code) => exits.push(code),
    })
  return { lifecycle, clock, exits, logs, run }
}

test('on shutdown /readyz turns 503 first, and the server stops only after the grace period', async () => {
  const stops: number[] = []
  const started = performance.now()
  const { lifecycle, exits, run } = harness({
    graceMs: 60,
    stop: () => {
      stops.push(performance.now() - started)
      return Promise.resolve()
    },
  })
  const app = createApp({ ...createTestDeps(), lifecycle })

  expect((await app.request('/readyz')).status).toBe(200)
  const done = run()

  expect((await app.request('/readyz')).status).toBe(503)
  expect(stops).toEqual([])
  await done
  expect(stops).toHaveLength(1)
  expect(stops[0]).toBeGreaterThanOrEqual(55)
  expect(exits).toEqual([0])
})

test('shutdown still exits, with code 1, when stopping rejects', async () => {
  const { exits, logs, run } = harness({
    graceMs: 0,
    stop: () => Promise.reject(new Error('socket already closed')),
  })

  await run()

  expect(exits).toEqual([1])
  expect(logs).toContain('shutdown failed')
})

test('a second signal at least one second after the first exits immediately with code 1', async () => {
  const { exits, clock, run } = harness({ graceMs: 40, stop: () => Promise.resolve() })

  const first = run()
  clock.advance('1s')
  await run()

  expect(exits).toEqual([1])
  await first
  expect(exits).toEqual([1, 0])
})

test('a duplicate signal under one second after the first is ignored, so the drain finishes', async () => {
  const { exits, clock, run } = harness({ graceMs: 40, stop: () => Promise.resolve() })

  const first = run()
  clock.advance('999ms')
  await run()

  expect(exits).toEqual([])
  await first
  expect(exits).toEqual([0])
})

test('a duplicate signal in the same instant is ignored', async () => {
  const { exits, run } = harness({ graceMs: 0, stop: () => Promise.resolve() })

  const first = run()
  await run()
  await first

  expect(exits).toEqual([0])
})

test.each([
  ['info', 'info'],
  ['error', 'error'],
] as const)('a logger.%s that throws cannot stop shutdown from exiting', async (_n, level) => {
  const lifecycle = { draining: false }
  const exits: number[] = []
  const throwing = () => {
    throw new Error('stdout closed')
  }
  await shutdown({
    signal: 'SIGTERM',
    server: {
      stop: () => (level === 'error' ? Promise.reject(new Error('x')) : Promise.resolve()),
    },
    lifecycle,
    clock: createFixedClock('2026-01-01T00:00:00Z'),
    logger: {
      info: level === 'info' ? throwing : () => {},
      error: level === 'error' ? throwing : () => {},
    },
    graceMs: 0,
    timeoutMs: 50,
    exit: (code) => exits.push(code),
  })

  expect(exits).toEqual([level === 'error' ? 1 : 0])
})

function uploaded() {
  return registry.create({
    type: 'playbook.document_uploaded',
    organizationId: newOrganizationId(),
    traceId: formatId('req', crypto.randomUUID()),
    payload: { documentId: formatId('doc', crypto.randomUUID()) },
  })
}

const noServer = () => ({ stop: async () => undefined })

test('stopping lets the message in flight finish, and then receives nothing more', async () => {
  let finished = false
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const deps = createTestDeps({
    handlers: {
      'playbook.document_uploaded': async () => {
        await gate
        finished = true
      },
    },
  })
  deps.consumer.start()
  await deps.queue.publish(uploaded())
  await deps.time.settle()
  expect(deps.queue.depth()).toEqual({ visible: 0, inFlight: 1 })

  const stopping = stoppableWith(noServer(), deps.consumer, 5_000).stop()
  release()
  await stopping

  expect(finished).toBe(true)
  expect(deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
  await deps.queue.publish(uploaded())
  await deps.time.advance(60_000)
  expect(deps.queue.depth()).toEqual({ visible: 1, inFlight: 0 })
})

test('a message still running at the deadline is aborted and given back to the queue', async () => {
  let aborted = false
  const deps = createTestDeps({
    handlers: {
      'playbook.document_uploaded': (_message, { signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
    },
  })
  deps.consumer.start()
  await deps.queue.publish(uploaded())
  await deps.time.settle()

  const stopping = stoppableWith(noServer(), deps.consumer, 5_000).stop()
  await deps.time.advance(5_000)
  await stopping

  expect(aborted).toBe(true)
  expect(deps.queue.depth()).toEqual({ visible: 1, inFlight: 0 })
})

test('stopping an idle consumer returns at once, and a second stop is harmless', async () => {
  const deps = createTestDeps()
  deps.consumer.start()
  await deps.time.settle()
  const stoppable = stoppableWith(noServer(), deps.consumer, 5_000)

  await stoppable.stop()
  await stoppable.stop(true)

  expect(deps.queue.depth()).toEqual({ visible: 0, inFlight: 0 })
})

test('stopping stops the server too, and a forced stop reaches it', async () => {
  const server = fakeServer(0)
  const deps = createTestDeps()
  const stoppable = stoppableWith(server, deps.consumer, 5_000)

  await stoppable.stop()
  await stoppable.stop(true)

  expect(server.calls).toEqual([undefined, true])
})
