import { describe, expect, test } from 'bun:test'
import {
  isLockTimeout,
  isRetryable,
  MAX_ATTEMPTS,
  postgresErrorOf,
  retryTransaction,
} from './retry'

function pgError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`pg ${code}`), { code, ...extra })
}

function recorder() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => void waits.push(ms) }
}

describe('retryTransaction', () => {
  test.each(['40001', '40P01'])(
    'a %s failure is run again and its success returned',
    async (code) => {
      const { sleep, waits } = recorder()
      let runs = 0

      const result = await retryTransaction(
        async () => {
          runs += 1
          if (runs < 3) {
            throw pgError(code)
          }
          return 'done'
        },
        { sleep, random: () => 0.5 }
      )

      expect(result).toBe('done')
      expect(runs).toBe(3)
      expect(waits).toHaveLength(2)
    }
  )

  test('it gives up after three runs and throws the last failure as it came', async () => {
    const { sleep } = recorder()
    const failure = pgError('40001')
    let runs = 0

    await expect(
      retryTransaction(
        async () => {
          runs += 1
          throw failure
        },
        { sleep }
      )
    ).rejects.toBe(failure)

    expect(runs).toBe(MAX_ATTEMPTS)
    expect(MAX_ATTEMPTS).toBe(3)
  })

  test.each(['23505', '23514', '57014', '08006'])('a %s failure is not retried', async (code) => {
    const { sleep } = recorder()
    let runs = 0

    await expect(
      retryTransaction(
        async () => {
          runs += 1
          throw pgError(code)
        },
        { sleep }
      )
    ).rejects.toThrow()

    expect(runs).toBe(1)
  })

  test('a failure that is not from Postgres is not retried', async () => {
    let runs = 0

    await expect(
      retryTransaction(async () => {
        runs += 1
        throw new TypeError('bug')
      })
    ).rejects.toThrow('bug')

    expect(runs).toBe(1)
  })

  test('waits are jittered below a ceiling that doubles and is capped', async () => {
    const low = recorder()
    const high = recorder()
    const fail = async () => {
      throw pgError('40P01')
    }

    await retryTransaction(fail, { sleep: low.sleep, random: () => 0 }).catch(() => undefined)
    await retryTransaction(fail, { sleep: high.sleep, random: () => 0.999999 }).catch(
      () => undefined
    )

    expect(low.waits).toEqual([0, 0])
    expect(high.waits).toHaveLength(2)
    expect(high.waits[0]).toBeLessThan(20)
    expect(high.waits[1]).toBeGreaterThan(high.waits[0] ?? 0)
    expect(high.waits[1]).toBeLessThan(40)
  })
})

describe('postgresErrorOf', () => {
  test('finds the driver error under the query builder wrapper', () => {
    const wrapped = new Error('Failed query', {
      cause: pgError('23505', { constraint: 'some_key' }),
    })

    expect(postgresErrorOf(wrapped)).toMatchObject({ code: '23505', constraint: 'some_key' })
    expect(isRetryable(wrapped)).toBe(false)
    expect(isRetryable(new Error('Failed query', { cause: pgError('55P03') }))).toBe(false)
    expect(isRetryable(new Error('Failed query', { cause: pgError('40001') }))).toBe(true)
  })

  test('an error with no SQLSTATE, or a cyclic chain, is not a Postgres error and ends', () => {
    const loop = new Error('loop')
    loop.cause = loop

    expect(postgresErrorOf(new Error('plain'))).toBeUndefined()
    expect(postgresErrorOf(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBeUndefined()
    expect(postgresErrorOf(loop)).toBeUndefined()
    expect(postgresErrorOf('not an error')).toBeUndefined()
  })
})

describe('isLockTimeout', () => {
  test('is true for 55P03 anywhere in a cause chain, false for other failures', () => {
    expect(isLockTimeout(new Error('wrapped', { cause: pgError('55P03') }))).toBe(true)
    expect(isLockTimeout(pgError('40P01'))).toBe(false)
    expect(isLockTimeout(new Error('plain'))).toBe(false)
  })
})
