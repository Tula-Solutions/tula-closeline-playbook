import { describe, expect, test } from 'bun:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  CONSUMED_CLAIM,
  CONSUMED_COMPLETE,
  CONSUMED_LOOKUP,
  CONSUMED_PURGE,
  CONSUMED_RELEASE,
  CONSUMED_RENEW,
} from 'tula-closeline-db'
import { GLOBAL_SCOPE_ORGANIZATION_ID } from 'tula-closeline-db/schema'
import {
  createPostgresProcessedStore,
  type InScope,
  ProcessedStorePurgeUnavailableError,
  type Result,
  type Run,
  statementOf,
} from './processed-store'

const ORG = 'org_0123456789abcdef0123456789abcdef'
const TOK = '11111111-2222-4333-8444-555555555555'
const key = { consumer: 'playbook.ingestion', organizationId: ORG, messageId: 'msg-1' }

type Call = { scope: string; text: string; params: readonly unknown[] }

/** A scope that answers each statement from a script and notes every call and transaction. */
function scripted(answers: Result[]) {
  const calls: Call[] = []
  const scopes: string[] = []
  const scope: InScope = async (organizationId, fn) => {
    scopes.push(organizationId)
    const run: Run = async (text, params) => {
      calls.push({ scope: organizationId, text, params })
      const next = answers.shift()
      if (!next) {
        throw new Error('the script ran out of answers')
      }
      return next
    }
    return fn(run)
  }
  return { scope, calls, scopes }
}

const none: Result = { rows: [], rowCount: 0 }
const one = (row: Record<string, unknown> = {}): Result => ({ rows: [row], rowCount: 1 })

describe('statementOf', () => {
  test('turns $n placeholders into bound parameters, each occurrence on its own', () => {
    const query = new PgDialect().sqlToQuery(
      statementOf('select $1, $2::uuid, $1 from t where x = $2', ['a', 'b'])
    )

    expect(query.sql).toBe('select $1, $2::uuid, $3 from t where x = $4')
    expect(query.params).toEqual(['a', 'b', 'a', 'b'])
  })

  test('refuses a placeholder that has no value', () => {
    expect(() => statementOf('select $2', ['only one'])).toThrow()
  })

  test('binds the claim statement of the db library, its lease twice', () => {
    const query = new PgDialect().sqlToQuery(statementOf(CONSUMED_CLAIM, ['c', ORG, 'm', 't', 1]))

    expect(query.params).toEqual(['c', ORG, 'm', 't', 1, 1])
  })
})

describe('claim', () => {
  test('a returned row is a claim, made under the message Organization with the lease in milliseconds', async () => {
    const { scope, calls } = scripted([one({ claim_token: 'ignored' })])
    const store = createPostgresProcessedStore({ scope, newToken: () => 'token-1' })

    const result = await store.claim(key, 60)

    expect(result).toEqual({ status: 'claimed', token: 'token-1' })
    expect(calls).toEqual([
      { scope: ORG, text: CONSUMED_CLAIM, params: [key.consumer, ORG, 'msg-1', 'token-1', 60_000] },
    ])
  })

  test('a global message is recorded under the all-zero Organization', async () => {
    const { scope, calls } = scripted([one()])
    const store = createPostgresProcessedStore({ scope, newToken: () => 't' })

    await store.claim({ ...key, organizationId: null }, 5)

    expect(calls[0]?.scope).toBe(GLOBAL_SCOPE_ORGANIZATION_ID)
    expect(calls[0]?.params).toEqual([
      key.consumer,
      GLOBAL_SCOPE_ORGANIZATION_ID,
      'msg-1',
      't',
      5000,
    ])
  })

  test('no row then a done record is done, read in a transaction of its own', async () => {
    const { scope, calls, scopes } = scripted([
      none,
      one({ state: 'done', retry_after_seconds: null }),
    ])
    const store = createPostgresProcessedStore({ scope })

    expect(await store.claim(key, 60)).toEqual({ status: 'done' })
    expect(calls.map((call) => call.text)).toEqual([CONSUMED_CLAIM, CONSUMED_LOOKUP])
    expect(calls[1]?.params).toEqual([key.consumer, ORG, 'msg-1'])
    expect(scopes).toHaveLength(2)
  })

  test('no row then a live claim is busy for the seconds the database says', async () => {
    const { scope } = scripted([none, one({ state: 'claimed', retry_after_seconds: 42 })])
    const store = createPostgresProcessedStore({ scope })

    expect(await store.claim(key, 60)).toEqual({ status: 'busy', retryAfterSeconds: 42 })
  })

  test('busy never reports less than one second', async () => {
    const { scope } = scripted([none, one({ state: 'claimed', retry_after_seconds: 0 })])
    const store = createPostgresProcessedStore({ scope })

    expect(await store.claim(key, 60)).toEqual({ status: 'busy', retryAfterSeconds: 1 })
  })

  test('a lookup that finds no row claims again, since the record was released or purged in between', async () => {
    const { scope, calls } = scripted([none, none, one()])
    const store = createPostgresProcessedStore({ scope, newToken: () => 't' })

    expect(await store.claim(key, 60)).toEqual({ status: 'claimed', token: 't' })
    expect(calls.map((call) => call.text)).toEqual([
      CONSUMED_CLAIM,
      CONSUMED_LOOKUP,
      CONSUMED_CLAIM,
    ])
  })

  test('a record that keeps vanishing between claim and lookup is an error, not a loop', async () => {
    const { scope, calls } = scripted(Array.from({ length: 20 }, () => none))
    const store = createPostgresProcessedStore({ scope, maxClaimAttempts: 3 })

    await expect(store.claim(key, 60)).rejects.toThrow()
    expect(calls).toHaveLength(6)
  })

  test('a state the table cannot hold is an error', async () => {
    const { scope } = scripted([none, one({ state: 'weird', retry_after_seconds: null })])
    const store = createPostgresProcessedStore({ scope })

    await expect(store.claim(key, 60)).rejects.toThrow()
  })
})

describe('renew, complete and release', () => {
  test('renew sends the lease in milliseconds and is true when a row changed', async () => {
    const { scope, calls } = scripted([one(), none])
    const store = createPostgresProcessedStore({ scope })

    expect(await store.renew(key, TOK, 30)).toBe(true)
    expect(await store.renew(key, TOK, 30)).toBe(false)
    expect(calls[0]).toEqual({
      scope: ORG,
      text: CONSUMED_RENEW,
      params: [key.consumer, ORG, 'msg-1', TOK, 30_000],
    })
  })

  test('complete is true only when a row changed', async () => {
    const { scope, calls } = scripted([one(), none])
    const store = createPostgresProcessedStore({ scope })

    expect(await store.complete(key, TOK)).toBe(true)
    expect(await store.complete(key, TOK)).toBe(false)
    expect(calls[0]).toEqual({
      scope: ORG,
      text: CONSUMED_COMPLETE,
      params: [key.consumer, ORG, 'msg-1', TOK],
    })
  })

  test('release deletes by token and answers nothing', async () => {
    const { scope, calls } = scripted([none])
    const store = createPostgresProcessedStore({ scope })

    await store.release({ ...key, organizationId: null }, TOK)

    expect(calls).toEqual([
      {
        scope: GLOBAL_SCOPE_ORGANIZATION_ID,
        text: CONSUMED_RELEASE,
        params: [key.consumer, GLOBAL_SCOPE_ORGANIZATION_ID, 'msg-1', TOK],
      },
    ])
  })
})

describe('purge', () => {
  test('purgeScope purges one Organization scope and reports how many rows went', async () => {
    const { scope, calls } = scripted([{ rows: [], rowCount: 7 }])
    const store = createPostgresProcessedStore({ scope })
    const before = new Date('2026-01-01T00:00:00Z')

    expect(await store.purgeScope(ORG, before, 100)).toBe(7)
    expect(calls).toEqual([
      { scope: ORG, text: CONSUMED_PURGE, params: [ORG, '2026-01-01T00:00:00.000Z', 100] },
    ])
  })

  test('purge says it cannot find the Organizations to purge, naming the missing piece', async () => {
    const { scope, calls } = scripted([])
    const store = createPostgresProcessedStore({ scope })

    const error = await store.purge(new Date(), 10).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ProcessedStorePurgeUnavailableError)
    expect((error as Error).message).toContain('#53')
    expect(calls).toHaveLength(0)
  })
})

describe('inputs the table could not hold', () => {
  const TOKEN = '0b0f6f0e-6f0e-4f0e-8f0e-0f0e6f0e6f0e'

  test.each(['wrong-token', '', 'nope', `${TOKEN}x`, ` ${TOKEN}`, TOKEN.replace(/-/g, '')])(
    'a token that is not a uuid (%j) renews, completes and releases nothing, without a query',
    async (token) => {
      const { scope, calls } = scripted([])
      const store = createPostgresProcessedStore({ scope })

      expect(await store.renew(key, token, 30)).toBe(false)
      expect(await store.complete(key, token)).toBe(false)
      await store.release(key, token)

      expect(calls).toHaveLength(0)
    }
  )

  test('a well-formed uuid token, in any case, still reaches the database', async () => {
    const { scope, calls } = scripted([one(), one()])
    const store = createPostgresProcessedStore({ scope })

    expect(await store.complete(key, TOKEN.toUpperCase())).toBe(true)
    expect(await store.renew(key, TOKEN, 30)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test.each([
    ['an empty message id', { messageId: '' }],
    ['a message id with a space', { messageId: 'has space' }],
    ['a message id of 129 characters', { messageId: 'm'.repeat(129) }],
    ['an empty consumer name', { consumer: '' }],
    ['a consumer name with a slash', { consumer: 'a/b' }],
  ])('%s cannot be a record: claim refuses it, the others find no record', async (_name, bad) => {
    const { scope, calls } = scripted([])
    const store = createPostgresProcessedStore({ scope })
    const badKey = { ...key, ...bad }

    await expect(store.claim(badKey, 60)).rejects.toThrow(/message id|consumer/)
    expect(await store.renew(badKey, TOKEN, 30)).toBe(false)
    expect(await store.complete(badKey, TOKEN)).toBe(false)
    await store.release(badKey, TOKEN)
    expect(calls).toHaveLength(0)
  })

  test('an Organization id that is not a wire id is refused by claim and finds no record elsewhere', async () => {
    const { scope, calls } = scripted([])
    const store = createPostgresProcessedStore({ scope })
    const badKey = { ...key, organizationId: 'org_a' }

    await expect(store.claim(badKey, 60)).rejects.toThrow(/Organization/)
    expect(await store.complete(badKey, TOKEN)).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a lease of %p seconds is refused by claim and renew',
    async (lease) => {
      const { scope, calls } = scripted([])
      const store = createPostgresProcessedStore({ scope })

      await expect(store.claim(key, lease)).rejects.toThrow(/lease/)
      await expect(store.renew(key, TOKEN, lease)).rejects.toThrow(/lease/)
      expect(calls).toHaveLength(0)
    }
  )

  test.each([0, 1.5, Number.NaN, -3])('a purge limit of %p is refused', async (limit) => {
    const { scope } = scripted([])
    const store = createPostgresProcessedStore({ scope })

    await expect(store.purgeScope(ORG, new Date(), limit)).rejects.toThrow(/limit/)
  })

  test('a purge cutoff that is not a date is refused', async () => {
    const { scope } = scripted([])
    const store = createPostgresProcessedStore({ scope })

    await expect(store.purgeScope(ORG, new Date(Number.NaN), 10)).rejects.toThrow(/cutoff/)
  })
})
