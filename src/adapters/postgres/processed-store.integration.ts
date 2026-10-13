// Runs the Postgres ProcessedStore against the compose Postgres (`bun run test:integration`); it
// is not part of `bun test src`. The kit's behaviour suite runs first, then what is specific to
// this table: Organization isolation under row-level security, the global scope, leases in
// milliseconds, and the claim race.
import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  createDb,
  ORGANIZATIONS_WITH_WORK,
  type WorkDiscoveryRow,
  withOrganization,
} from 'tula-closeline-db'
import { GLOBAL_SCOPE_ORGANIZATION_ID } from 'tula-closeline-db/schema'
import type { ConsumedKey, ProcessedStore } from 'tula-closeline-kit'
import { processedStoreBehaviour } from 'tula-closeline-kit/testing/behaviour'
import { integrationUrls } from '~/integration-support'
import {
  createPostgresProcessedStore,
  type Discover,
  scopeOver,
  statementOf,
} from './processed-store'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
afterAll(async () => {
  await Promise.allSettled([service.close(), owner.close()])
})

const ORG_A = `org_${'a'.repeat(32)}`
const ORG_B = `org_${'b'.repeat(32)}`
const SCOPES = [ORG_A, ORG_B, GLOBAL_SCOPE_ORGANIZATION_ID]

/** Empties the table in every scope the suites use, as the owner (the service role cannot delete across scopes). */
async function clear(): Promise<void> {
  for (const scope of SCOPES) {
    await withOrganization(owner.db, scope, (tx) =>
      tx.execute(sql`delete from playbook.consumed_message`)
    )
  }
}

/** Moves every record `seconds` into the past, so leases lapse and completed records age without a wait. */
async function pass(seconds: number): Promise<void> {
  for (const scope of SCOPES) {
    await withOrganization(owner.db, scope, (tx) =>
      tx.execute(sql`
        update playbook.consumed_message
        set lease_expires_at = lease_expires_at - make_interval(secs => ${seconds}),
            completed_at = completed_at - make_interval(secs => ${seconds})`)
    )
  }
}

const discover: Discover = (kind, after, batch) =>
  service.db.transaction(async (tx) => {
    const result = await tx.execute(statementOf(ORGANIZATIONS_WITH_WORK, [kind, after, batch]))
    return result.rows as unknown as WorkDiscoveryRow[]
  })
const postgres = createPostgresProcessedStore({ scope: scopeOver(service.db), discover })
const withoutDiscovery = createPostgresProcessedStore({ scope: scopeOver(service.db) })

// The suite names Organizations `org_a` and `org_b`, which are not wire ids: map them to real
// ones, and make `purge` run `purgeScope` over the scopes the suite uses (the real `purge` finds
// them through discovery and is covered below).
const IDS: Record<string, string> = { org_a: ORG_A, org_b: ORG_B }
const wire = (key: ConsumedKey): ConsumedKey => ({
  ...key,
  organizationId:
    key.organizationId === null ? null : (IDS[key.organizationId] ?? key.organizationId),
})
const suiteStore: ProcessedStore = {
  claim: (key, lease) => postgres.claim(wire(key), lease),
  renew: (key, token, lease) => postgres.renew(wire(key), token, lease),
  complete: (key, token) => postgres.complete(wire(key), token),
  release: (key, token) => postgres.release(wire(key), token),
  purge: async (before, limit) => {
    let removed = 0
    for (const scope of SCOPES) {
      if (removed >= limit) {
        break
      }
      removed += await postgres.purgeScope(scope, before, limit - removed)
    }
    return removed
  },
}

processedStoreBehaviour('postgres processed store', async () => {
  await clear()
  return {
    store: suiteStore,
    pass,
    now: () => new Date(),
    close: clear,
  }
})

const key = (organizationId: string | null, messageId = 'm1'): ConsumedKey => ({
  consumer: 'playbook.ingestion',
  organizationId,
  messageId,
})

type Row = {
  organization_id: string
  message_id: string
  state: string
  lease_ms: number | null
}

/** The rows one scope can see, read as the owner inside that scope. */
async function rowsIn(scope: string): Promise<Row[]> {
  return withOrganization(owner.db, scope, async (tx) => {
    const result = await tx.execute<Row>(sql`
      select organization_id, message_id, state,
             (extract(epoch from lease_expires_at - clock_timestamp()) * 1000)::float8 as lease_ms
      from playbook.consumed_message`)
    return result.rows
  })
}

describe('Organization isolation', () => {
  test("a second Organization sees none of the first one's records, and cannot touch them", async () => {
    await clear()
    const claimed = await postgres.claim(key(ORG_A), 60)
    if (claimed.status !== 'claimed') {
      throw new Error('expected a claim')
    }

    expect(await rowsIn(ORG_B)).toEqual([])
    expect((await rowsIn(ORG_A)).map((row) => row.message_id)).toEqual(['m1'])
    // The same message id in the other Organization is a different message.
    expect(await postgres.claim(key(ORG_B), 60)).toMatchObject({ status: 'claimed' })
    // A token is no use under another Organization's key.
    expect(await postgres.complete(key(ORG_B), claimed.token)).toBe(false)
    expect(await postgres.complete(key(ORG_A), claimed.token)).toBe(true)
  })

  test('a statement that names another Organization inside this scope finds nothing and writes nothing', async () => {
    await clear()
    await postgres.claim(key(ORG_A), 60)
    const scope = scopeOver(service.db)

    const seen = await scope(ORG_B, (run) =>
      run('select state from playbook.consumed_message where organization_id = $1', [ORG_A])
    )
    const forged = scope(ORG_B, (run) =>
      run(
        `insert into playbook.consumed_message
           (consumer, organization_id, message_id, state, claim_token, lease_expires_at)
         values ('c', $1, 'm', 'claimed', gen_random_uuid(), clock_timestamp() + interval '1 minute')`,
        [ORG_A]
      )
    )

    expect(seen.rows).toEqual([])
    await expect(forged).rejects.toThrow()
  })

  test("purging one scope leaves every other scope's records alone", async () => {
    await clear()
    for (const organizationId of [ORG_A, ORG_B, null]) {
      const k = key(organizationId)
      const claimed = await postgres.claim(k, 60)
      if (claimed.status === 'claimed') {
        await postgres.complete(k, claimed.token)
      }
    }
    await pass(60)

    expect(await postgres.purgeScope(ORG_A, new Date(), 100)).toBe(1)

    expect(await rowsIn(ORG_A)).toEqual([])
    expect(await rowsIn(ORG_B)).toHaveLength(1)
    expect(await rowsIn(GLOBAL_SCOPE_ORGANIZATION_ID)).toHaveLength(1)
  })

  test('a store built without discovery refuses a table-wide purge and removes nothing', async () => {
    await clear()
    const k = key(ORG_A)
    const claimed = await postgres.claim(k, 60)
    if (claimed.status === 'claimed') {
      await postgres.complete(k, claimed.token)
    }
    await pass(60)

    await expect(withoutDiscovery.purge(new Date(), 100)).rejects.toThrow(/discover/)

    expect(await rowsIn(ORG_A)).toHaveLength(1)
  })

  test('the table-wide purge finds every Organization and the global scope through discovery', async () => {
    await clear()
    for (const organizationId of [ORG_A, ORG_B, null]) {
      const k = key(organizationId)
      const claimed = await postgres.claim(k, 60)
      if (claimed.status === 'claimed') {
        await postgres.complete(k, claimed.token)
      }
    }
    await pass(60 * 60 * 24 * 16)

    await postgres.purge(new Date(), 100)

    expect(await rowsIn(ORG_A)).toEqual([])
    expect(await rowsIn(ORG_B)).toEqual([])
    expect(await rowsIn(GLOBAL_SCOPE_ORGANIZATION_ID)).toEqual([])
  })
})

describe('what the table holds', () => {
  test('a global message is recorded under the all-zero Organization and no other scope can see it', async () => {
    await clear()
    await postgres.claim(key(null), 60)

    const global = await rowsIn(GLOBAL_SCOPE_ORGANIZATION_ID)
    expect(global.map((row) => row.organization_id)).toEqual([GLOBAL_SCOPE_ORGANIZATION_ID])
    expect(await rowsIn(ORG_A)).toEqual([])
  })

  test('the lease is stored in the seconds asked for, not in milliseconds taken as seconds', async () => {
    await clear()
    await postgres.claim(key(ORG_A), 30)

    const [row] = await rowsIn(ORG_A)

    expect(row?.lease_ms).toBeGreaterThan(25_000)
    expect(row?.lease_ms).toBeLessThanOrEqual(30_000)
  })

  test('a lease shorter than the library minimum is raised to it', async () => {
    await clear()
    await postgres.claim(key(ORG_A), 0.001)

    const [row] = await rowsIn(ORG_A)

    expect(row?.lease_ms).toBeGreaterThan(500)
  })

  test('the wire id is stored as it came, with no prefix stripped or converted', async () => {
    await clear()
    await postgres.claim(key(ORG_A), 60)

    const [row] = await rowsIn(ORG_A)

    expect(row?.organization_id).toBe(ORG_A)
  })

  test('a message id that is not a plain identifier is refused rather than stored', async () => {
    await clear()

    await expect(postgres.claim(key(ORG_A, 'has space'), 60)).rejects.toThrow()
  })
})

describe('the global scope', () => {
  test('a null key and the all-zero Organization id are not interchangeable', async () => {
    await clear()
    const claimed = await postgres.claim(key(null), 60)
    if (claimed.status !== 'claimed') {
      throw new Error('expected a claim')
    }

    await expect(postgres.claim(key(GLOBAL_SCOPE_ORGANIZATION_ID), 60)).rejects.toThrow()
    expect(await postgres.complete(key(GLOBAL_SCOPE_ORGANIZATION_ID), claimed.token)).toBe(false)
    expect(await postgres.complete(key(null), claimed.token)).toBe(true)
  })
})

describe('claiming', () => {
  test('of many concurrent claims for one message, exactly one wins and the rest see it busy', async () => {
    await clear()

    const results = await Promise.all(
      Array.from({ length: 12 }, () => postgres.claim(key(ORG_A, 'race'), 60))
    )

    expect(results.filter((result) => result.status === 'claimed')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'busy')).toHaveLength(11)
  })

  test('a done message is done for everyone, and a released claim can be taken again', async () => {
    await clear()
    const k = key(ORG_A)
    const first = await postgres.claim(k, 60)
    if (first.status !== 'claimed') {
      throw new Error('expected a claim')
    }
    await postgres.release(k, first.token)

    const second = await postgres.claim(k, 60)
    if (second.status !== 'claimed') {
      throw new Error('expected a second claim')
    }
    await postgres.complete(k, second.token)

    expect(await postgres.claim(k, 60)).toEqual({ status: 'done' })
  })
})
