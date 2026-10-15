import { describe, expect, test } from 'bun:test'
import { createMemoryErrorReporter } from 'tula-closeline-kit/testing'
import { scrubForTracker, trackerSafe } from './tracker-safe'

/** A Postgres error as `pg` builds it, with a row in its detail and a value in its message. */
function postgresError(): Error {
  const error = new Error('invalid input syntax for type uuid: "Alex Prospect"')
  error.name = 'error'
  Object.assign(error, {
    severity: 'ERROR',
    code: '22P02',
    detail: 'Failing row contains (call_1, Alex Prospect, secret-file-name.txt).',
    where: 'COPY calls, line 1: "Alex Prospect"',
    hint: 'Key (speaker)=(Alex Prospect) is not present',
    parameters: ['Alex Prospect'],
    table: 'calls',
    constraint: 'calls_pkey',
    routine: 'string_to_uuid',
  })
  return error
}

/** What drizzle throws: the SQL and the parameter values in the message, the pg error as the cause. */
function drizzleError(): Error {
  const wrapper = new Error(
    'Failed query: insert into t values ($1)\nparams: Alex Prospect,notes.txt',
    {
      cause: postgresError(),
    }
  )
  wrapper.name = 'DrizzleQueryError'
  Object.assign(wrapper, {
    query: 'insert into t values ($1)',
    params: ['Alex Prospect', 'notes.txt'],
  })
  return wrapper
}

/** Everything a tracker could read off the error: own properties, message, stack, the cause chain. */
function everythingReadable(error: unknown, depth = 0): string {
  if (!(error instanceof Error) || depth > 8) {
    return String(error)
  }
  const own = Object.fromEntries(
    Object.getOwnPropertyNames(error)
      .filter((key) => key !== 'cause')
      .map((key) => [key, (error as unknown as Record<string, unknown>)[key]])
  )
  return `${JSON.stringify(own)}\n${everythingReadable(error.cause, depth + 1)}`
}

const SECRETS = ['Alex Prospect', 'secret-file-name', 'notes.txt', 'Failing row']

describe('what the error tracker receives from a Postgres error', () => {
  test('a row-bearing detail never reaches the reporter, through the wrapper or the cause', () => {
    const memory = createMemoryErrorReporter()
    const reporter = trackerSafe(memory)

    reporter.capture(drizzleError(), {})
    reporter.capture(postgresError(), {})
    reporter.capture(new Error('upload failed', { cause: drizzleError() }), {})

    expect(memory.captured.length).toBe(3)
    for (const { error } of memory.captured) {
      const text = everythingReadable(error)
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret)
      }
    }
  })

  test('a Postgres error inside an AggregateError is scrubbed too', () => {
    const memory = createMemoryErrorReporter()
    trackerSafe(memory).capture(
      new AggregateError([drizzleError(), postgresError()], 'both failed'),
      {}
    )

    const [captured] = memory.captured
    const inner = ((captured?.error ?? new AggregateError([])) as AggregateError).errors as Error[]
    expect(inner).toHaveLength(2)
    for (const error of inner) {
      for (const secret of SECRETS) {
        expect(everythingReadable(error)).not.toContain(secret)
      }
    }
  })

  test('the code, table and constraint stay, so the report still says what failed', () => {
    const scrubbed = scrubForTracker(drizzleError()) as Error
    const inner = scrubbed.cause as Error & Record<string, unknown>
    expect(inner).toMatchObject({ code: '22P02', table: 'calls', constraint: 'calls_pkey' })
    expect(inner.message).toContain('22P02')
    expect(inner.stack).toContain('at ')
  })

  test('an error that is not a database error is passed on unchanged', () => {
    const plain = new RangeError('too many chunks')
    expect(scrubForTracker(plain)).toBe(plain)
    expect(scrubForTracker('text')).toBe('text')
  })

  test('a cyclic cause chain ends', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b
    expect(() => {
      scrubForTracker(a)
    }).not.toThrow()
  })

  test('the original error is not changed', () => {
    const original = drizzleError()
    scrubForTracker(original)
    expect(original.message).toContain('Alex Prospect')
  })
})
