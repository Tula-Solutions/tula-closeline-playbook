import { describe, expect, test } from 'bun:test'
import { callSchema } from 'tula-closeline-contract'
import { CALL_CLEANUP_DONE } from 'tula-closeline-db'
import { INTERNAL_SECRET, newKey } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'
import { cleanupPendingCalls, logSpentCallPurges, purgeCalls } from './purge'
import { type CallHarness, createCallHarness, transcriptText } from './test-support'

const removeAll = (h: CallHarness, organizationId: string) =>
  h.app.request(`/internal/playbook/organizations/${organizationId}/remove-all`, {
    method: 'POST',
    headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'idempotency-key': newKey() },
  })

/** Uploads and processes one Transcript; returns its Call id. */
async function readyCall(h: CallHarness, seed: string, dealId = 'DEAL-1'): Promise<string> {
  const response = await h.uploadCall(transcriptText(seed), { dealId })
  const call = callSchema.parse(await response.json())
  await h.runCalls()
  return call.id
}

/** Marks a Call deleted and due for purge, as the delete route (a later ticket) would. */
function deleteNow(h: CallHarness, id: string, options: { dueIn?: number } = {}): void {
  const row = h.deps.database.calls(h.organizationId).find((c) => c.id === id)
  if (row === undefined) {
    throw new Error('no such Call')
  }
  const now = h.deps.clock.now().getTime()
  row.state = 'deleted'
  row.deleted_at = now
  row.deletion_seq += 1
  row.epoch += 1
  row.purge_due_at = now + (options.dueIn ?? 0)
}

const vectorCount = async (h: CallHarness, callId: string, org: string = h.organizationId) =>
  (
    await h.deps.vectors.search(org, {
      vector: new Array<number>(h.deps.vectors.dimensions).fill(0.1),
      topK: 100,
      filter: { call_id: callId },
    })
  ).length

/** The first committed Call of the harness Organization. */
function firstCall(h: CallHarness) {
  const row = h.deps.database.calls(h.organizationId)[0]
  if (row === undefined) {
    throw new Error('no Call')
  }
  return row
}

const abort = () => new AbortController().signal

describe('purging Calls', () => {
  test('a due Call loses its vectors, its objects and its row', async () => {
    const h = await createCallHarness()
    const id = await readyCall(h, 'a')
    expect(await vectorCount(h, id)).toBeGreaterThan(0)
    deleteNow(h, id)

    const result = await purgeCalls(h.deps, h.organizationId, abort())

    expect(result).toEqual({ purged: 1, deferred: 0 })
    expect(await vectorCount(h, id)).toBe(0)
    expect(await h.objectKeys()).toEqual([])
    expect(h.deps.database.calls(h.organizationId)).toEqual([])
    expect(h.deps.database.callJobs(h.organizationId)).toEqual([])
  })

  test('a Call not yet due is left alone, and another Organization is never touched', async () => {
    const h = await createCallHarness()
    const id = await readyCall(h, 'a')
    deleteNow(h, id, { dueIn: 60_000 })
    const other = newOrganizationId()

    expect(await purgeCalls(h.deps, h.organizationId, abort())).toEqual({ purged: 0, deferred: 0 })
    expect(await purgeCalls(h.deps, other, abort())).toEqual({ purged: 0, deferred: 0 })
    expect(await vectorCount(h, id)).toBeGreaterThan(0)
  })

  test('a Call whose job lease has not ended is deferred, not failed, and goes on the next pass', async () => {
    const h = await createCallHarness()
    const response = await h.uploadCall(transcriptText('busy'))
    const id = callSchema.parse(await response.json()).id
    const job = h.deps.database.callJobs(h.organizationId)[0]
    if (job === undefined) {
      throw new Error('no job')
    }
    deleteNow(h, id)
    job.state = 'cancelled'
    job.next_attempt_at = h.deps.clock.now().getTime() + 60_000

    expect(await purgeCalls(h.deps, h.organizationId, abort())).toEqual({ purged: 0, deferred: 0 })
    await h.deps.time.advance(2 * 60_000)

    expect(await purgeCalls(h.deps, h.organizationId, abort())).toEqual({ purged: 1, deferred: 0 })
  })

  test('a failing vector store leaves the row, and the next pass finishes', async () => {
    const h = await createCallHarness()
    const id = await readyCall(h, 'a')
    deleteNow(h, id)
    const base = h.deps.vectors.deleteByFilter.bind(h.deps.vectors)
    let fail = true
    h.deps.vectors.deleteByFilter = async (...args) => {
      if (fail) {
        fail = false
        throw new Error('store down')
      }
      return base(...args)
    }

    await expect(purgeCalls(h.deps, h.organizationId, abort())).rejects.toThrow('store down')
    expect(h.deps.database.calls(h.organizationId)).toHaveLength(1)
    await h.deps.time.advance(2 * 60_000)
    firstCall(h).purge_lease_until = null

    expect(await purgeCalls(h.deps, h.organizationId, abort())).toEqual({ purged: 1, deferred: 0 })
    expect(await vectorCount(h, id)).toBe(0)
  })

  test('the cleanup sweep removes the vectors of a deletion whose message was lost, but not a fresh one', async () => {
    const h = await createCallHarness()
    const id = await readyCall(h, 'a')
    deleteNow(h, id, { dueIn: 30 * 24 * 3600_000 })

    expect(await cleanupPendingCalls(h.deps, h.organizationId, abort())).toBe(0)
    expect(await vectorCount(h, id)).toBeGreaterThan(0)
    await h.deps.time.advance(10 * 60_000)

    expect(await cleanupPendingCalls(h.deps, h.organizationId, abort())).toBe(1)
    expect(await vectorCount(h, id)).toBe(0)
    h.deps.database.failNext(CALL_CLEANUP_DONE, new Error('never reached'))
    expect(await cleanupPendingCalls(h.deps, h.organizationId, abort())).toBe(0)
  })

  test('a spent purge is logged with ids only', async () => {
    const h = await createCallHarness()
    const id = await readyCall(h, 'a')
    deleteNow(h, id)
    firstCall(h).purge_attempts = 99

    expect(await logSpentCallPurges(h.deps, h.organizationId)).toBe(1)
    const line = h.deps.logLines.find((l) => l.includes('Call purges have given up'))
    expect(line).toContain(id)
    expect(line).not.toContain('call.txt')
  })

  test('the sweeps run the Call kinds', async () => {
    const h = await createCallHarness()
    const id = await readyCall(h, 'a')
    deleteNow(h, id)
    await h.deps.time.advance(10 * 60_000)

    await h.deps.workers.sweeps.run('cleanup')
    await h.deps.workers.sweeps.run('purge')
    await h.deps.workers.sweeps.run('housekeeping')

    expect(h.deps.database.calls(h.organizationId)).toEqual([])
    const kinds = new Set(h.deps.database.discoveries.map((d) => d.kind))
    expect(kinds.has('call_cleanup')).toBe(true)
    expect(kinds.has('call_purge')).toBe(true)
    expect(kinds.has('call_purge_spent')).toBe(true)
  })
})

describe('remove-all with Calls', () => {
  test('erases Calls before Deals and ends in 200, with no vector, object or row left', async () => {
    const h = await createCallHarness()
    const a = await readyCall(h, 'a', 'DEAL-A')
    const b = await readyCall(h, 'b', 'DEAL-B')
    await h.uploadCall(transcriptText('c'), { dealId: 'DEAL-C' }) // still queued

    let status = 503
    for (let round = 0; round < 6 && status !== 200; round++) {
      status = (await removeAll(h, h.organizationId)).status
    }

    expect(status).toBe(200)
    expect(h.deps.database.calls(h.organizationId)).toEqual([])
    expect(h.deps.database.deals(h.organizationId)).toEqual([])
    expect(await vectorCount(h, a)).toBe(0)
    expect(await vectorCount(h, b)).toBe(0)
    expect(await h.objectKeys()).toEqual([])
  })

  test('while a Call cannot be purged yet the answer is 503 and no Deal is erased', async () => {
    const h = await createCallHarness()
    const response = await h.uploadCall(transcriptText('busy'))
    callSchema.parse(await response.json())
    const job = h.deps.database.callJobs(h.organizationId)[0]
    if (job === undefined) {
      throw new Error('no job')
    }
    // A running job holds the Call until its lease ends.
    job.state = 'running'
    job.next_attempt_at = h.deps.clock.now().getTime() + 60_000

    const first = await removeAll(h, h.organizationId)

    expect(first.status).toBe(503)
    expect(h.deps.database.calls(h.organizationId)).toHaveLength(1)
    expect(h.deps.database.deals(h.organizationId)).toHaveLength(1)
  })

  test('only the named Organization is touched', async () => {
    const h = await createCallHarness()
    await readyCall(h, 'a')
    const other = newOrganizationId()
    h.confirmRights(other)
    h.deps.database.seedDeal({
      id: `deal_${'7'.repeat(32)}`,
      organization_id: other,
      deal_id: 'OTHER',
    })
    h.deps.database.seedCall({
      id: `call_${'7'.repeat(32)}`,
      organization_id: other,
      deal_record_id: `deal_${'7'.repeat(32)}`,
    })

    for (let round = 0; round < 6; round++) {
      if ((await removeAll(h, h.organizationId)).status === 200) {
        break
      }
    }

    expect(h.deps.database.calls(other)).toHaveLength(1)
    expect(h.deps.database.deals(other)).toHaveLength(1)
  })
})
