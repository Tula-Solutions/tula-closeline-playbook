// Runs the Call routes, job, purge and erase against the compose Postgres (`bun run test:integration`);
// it is not part of `bun test src`. The unit suite runs them on a double of the database; this runs
// the db library's real statements: the insert under the upload lock and the rights check, the claim,
// the completion under the Deal row lock, the cleanup and purge claims and the erase order against the
// Deal foreign key. Objects, vectors and the queue stay in memory.

import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { type Call, callSchema } from 'tula-closeline-contract'
import {
  createDb,
  ORGANIZATIONS_WITH_WORK,
  RIGHTS_CONFIRM,
  type WorkDiscoveryRow,
  withOrganization,
} from 'tula-closeline-db'
import { type Discover, scopeOver, statementOf } from '~/adapters/postgres/processed-store'
import { integrationUrls } from '~/integration-support'
import { errorCode, INTERNAL_SECRET, newKey, personIn } from '~/modules/document/test-support'
import { purgeCalls } from './purge'
import { CALLS, type CallHarness, createCallHarness, transcriptText } from './test-support'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
afterAll(async () => {
  await Promise.allSettled([service.close(), owner.close()])
})

const discover: Discover = (kind, after, batch) =>
  service.db.transaction(async (tx) => {
    const result = await tx.execute(statementOf(ORGANIZATIONS_WITH_WORK, [kind, after, batch]))
    return result.rows as unknown as WorkDiscoveryRow[]
  })

/** A harness over the real database, with its own Organization and its own people. */
async function harness(): Promise<CallHarness> {
  const h = await createCallHarness({ scope: scopeOver(service.db) })
  h.deps.discover = discover
  // The memory double's seeded confirmation does not exist here: record the real one.
  await h.deps.scope(h.organizationId, (run) =>
    run(RIGHTS_CONFIRM, [
      h.organizationId,
      h.people.owner.userId,
      h.deps.env.RIGHTS_WORDING_VERSION,
    ])
  )
  return h
}

/** Counts rows of a table in an Organization, as the table owner under that Organization's scope. */
async function count(organizationId: string, table: string): Promise<number> {
  const result = await withOrganization(owner.db, organizationId, (tx) =>
    tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from playbook.${table}`))
  )
  return result.rows[0]?.n ?? -1
}

async function uploadOk(h: CallHarness, seed: string, dealId = 'DEAL-1'): Promise<Call> {
  const response = await h.uploadCall(transcriptText(seed), { dealId })
  expect(response.status).toBe(201)
  return callSchema.parse(await response.json())
}

describe('a Call against Postgres', () => {
  test('is uploaded under the rights check, processed to ready and listed', async () => {
    const h = await harness()
    const call = await uploadOk(h, 'one')

    await h.runCalls()

    expect(await h.readCall(call.id)).toMatchObject({
      state: 'ready',
      speakerLabels: ['Alex', 'Sam'],
    })
    expect((await h.listAll()).map((c) => c.id)).toEqual([call.id])
    expect(await count(h.organizationId, 'calls')).toBe(1)
    expect(await count(h.organizationId, 'deals')).toBe(1)
  })

  test('a Rep label not in the file fails the Call and keeps the labels it does hold; too many speakers keeps none', async () => {
    const h = await harness()
    const response = await h.uploadCall(transcriptText('norep'), {
      rep: JSON.stringify({ by: 'speaker', label: 'Nobody' }),
    })
    const wrong = callSchema.parse(await response.json())
    const many = await uploadOk(
      h,
      `${Array.from({ length: 21 }, (_, i) => `Speaker${i}: hello number ${i}`).join('\n')}\n`,
      'DEAL-MANY'
    )

    await h.runCalls()

    expect(await h.readCall(wrong.id)).toMatchObject({
      state: 'failed',
      failureReason: 'rep_label_not_found',
      speakerLabels: ['Alex', 'Sam'],
    })
    expect(await h.readCall(many.id)).toMatchObject({
      state: 'failed',
      failureReason: 'too_many_speakers',
      speakerLabels: [],
    })
  })

  test('answers the duplicate rule: the same file is the stored Call, another deal is refused', async () => {
    const h = await harness()
    const first = await uploadOk(h, 'dup')

    const again = await h.uploadCall(transcriptText('dup'))
    const other = await h.uploadCall(transcriptText('dup'), { dealId: 'DEAL-2' })

    expect(again.status).toBe(200)
    expect(callSchema.parse(await again.json()).id).toBe(first.id)
    expect(other.status).toBe(409)
    expect(await errorCode(other)).toBe('call.content_in_other_deal')
    expect(await count(h.organizationId, 'calls')).toBe(1)
  })

  test('without a confirmation at the current wording version nothing is stored', async () => {
    const h = await harness()
    await withOrganization(owner.db, h.organizationId, (tx) =>
      tx.execute(sql`delete from playbook.rights_confirmations`)
    )

    const response = await h.uploadCall(transcriptText('norights'))

    expect(response.status).toBe(403)
    expect(await errorCode(response)).toBe('rights.confirmation_required')
    expect(await count(h.organizationId, 'calls')).toBe(0)
    expect(await h.objectKeys()).toHaveLength(0)
  })

  test('a second Organization sees none of it', async () => {
    const h = await harness()
    const call = await uploadOk(h, 'iso')
    await h.runCalls()
    const stranger = personIn(`org_${'9'.repeat(32)}`, 'owner')

    expect((await h.send('GET', `${CALLS}/${call.id}`, { as: stranger })).status).toBe(404)
    expect(
      ((await (await h.send('GET', CALLS, { as: stranger })).json()) as { items: unknown[] }).items
    ).toEqual([])
  })

  test('a lost job (another claim) writes nothing and leaves the Call processing', async () => {
    const h = await harness()
    const call = await uploadOk(h, 'lost')
    const base = h.deps.objects.get.bind(h.deps.objects)
    h.deps.objects.get = async (...args) => {
      const stored = await base(...args)
      await withOrganization(owner.db, h.organizationId, (tx) =>
        tx.execute(sql`update playbook.call_jobs set claim_token = gen_random_uuid()`)
      )
      return stored
    }

    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('processing')
  })

  test('purge removes the row and its jobs, and remove-all erases Calls before Deals', async () => {
    const h = await harness()
    const a = await uploadOk(h, 'a', 'DEAL-A')
    await h.runCalls()
    await uploadOk(h, 'b', 'DEAL-B')

    await withOrganization(owner.db, h.organizationId, (tx) =>
      tx.execute(
        sql`update playbook.calls set state = 'deleted', deleted_at = now(), deletion_seq = deletion_seq + 1, epoch = epoch + 1, purge_due_at = now() where id = ${a.id}`
      )
    )
    await purgeCalls(h.deps, h.organizationId, new AbortController().signal)
    expect(await count(h.organizationId, 'calls')).toBe(1)

    let status = 503
    for (let round = 0; round < 6 && status !== 200; round++) {
      status = (
        await h.app.request(`/internal/playbook/organizations/${h.organizationId}/remove-all`, {
          method: 'POST',
          headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'idempotency-key': newKey() },
        })
      ).status
    }

    expect(status).toBe(200)
    expect(await count(h.organizationId, 'calls')).toBe(0)
    expect(await count(h.organizationId, 'deals')).toBe(0)
    expect(await h.objectKeys()).toEqual([])
  })
})
