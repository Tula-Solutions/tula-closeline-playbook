import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { exitAfterClose, installCrashHandlers } from './exit'

const never = () => new Promise<void>(() => {})

describe('exitAfterClose', () => {
  test('a clean exit waits for close to finish, then exits 0', async () => {
    const exits: number[] = []
    let finishClose: () => void = () => undefined
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve
    })

    exitAfterClose({ code: 0, close: () => closing, exit: (c) => exits.push(c), deadlineMs: 20 })
    await Bun.sleep(60)
    expect(exits).toEqual([])
    finishClose()
    await Bun.sleep(5)

    expect(exits).toEqual([0])
  })

  test('a clean exit whose close fails exits 1', async () => {
    const exits: number[] = []

    exitAfterClose({
      code: 0,
      close: () => Promise.reject(new Error('pool stuck')),
      exit: (c) => exits.push(c),
      deadlineMs: 20,
    })
    await Bun.sleep(10)

    expect(exits).toEqual([1])
  })

  test('a forced exit gives close its deadline and then exits with the same code', async () => {
    const exits: number[] = []
    const started = performance.now()

    exitAfterClose({ code: 1, close: never, exit: (c) => exits.push(c), deadlineMs: 30 })
    await Bun.sleep(10)
    expect(exits).toEqual([])
    await Bun.sleep(60)

    expect(exits).toEqual([1])
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('a forced exit does not wait out the deadline when close is quick', async () => {
    const exits: number[] = []

    exitAfterClose({
      code: 1,
      close: async () => undefined,
      exit: (c) => exits.push(c),
      deadlineMs: 5_000,
    })
    await Bun.sleep(10)

    expect(exits).toEqual([1])
  })

  test('a forced exit whose close fails still exits with the original code', async () => {
    const exits: number[] = []

    exitAfterClose({
      code: 2,
      close: () => Promise.reject(new Error('x')),
      exit: (c) => exits.push(c),
      deadlineMs: 5_000,
    })
    await Bun.sleep(10)

    expect(exits).toEqual([2])
  })
})

describe('installCrashHandlers', () => {
  function setup() {
    const target = new EventEmitter()
    const reported: { error: unknown; path: string; method: string }[] = []
    const exits: number[] = []
    installCrashHandlers({
      target,
      report: (error, context) => reported.push({ error, ...context }),
      close: async () => undefined,
      exit: (c) => exits.push(c),
      deadlineMs: 20,
    })
    return { target, reported, exits }
  }

  test('an uncaught exception is reported once and the process exits non-zero', async () => {
    const { target, reported, exits } = setup()
    const error = new Error('boom')

    target.emit('uncaughtException', error)
    await Bun.sleep(10)

    expect(reported).toHaveLength(1)
    expect(reported[0]?.error).toBe(error)
    expect(reported[0]?.method).toBe('PROCESS')
    expect(exits).toEqual([1])
  })

  test('an unhandled rejection is reported and exits non-zero too', async () => {
    const { target, reported, exits } = setup()

    target.emit('unhandledRejection', 'a string reason')
    await Bun.sleep(10)

    expect(reported).toHaveLength(1)
    expect(exits).toEqual([1])
  })

  test('a second failure while exiting is not reported or exited again', async () => {
    const { target, reported, exits } = setup()

    target.emit('uncaughtException', new Error('first'))
    target.emit('unhandledRejection', new Error('second'))
    await Bun.sleep(10)

    expect(reported).toHaveLength(1)
    expect(exits).toEqual([1])
  })

  test('a reporter that throws does not stop the exit', async () => {
    const target = new EventEmitter()
    const exits: number[] = []
    installCrashHandlers({
      target,
      report: () => {
        throw new Error('reporter down')
      },
      close: async () => undefined,
      exit: (c) => exits.push(c),
      deadlineMs: 20,
    })

    target.emit('uncaughtException', new Error('boom'))
    await Bun.sleep(10)

    expect(exits).toEqual([1])
  })
})
