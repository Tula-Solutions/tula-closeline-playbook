import { describe, expect, test } from 'bun:test'
import {
  CALL_CLEANUP_BEGIN,
  CALL_CLEANUP_DONE,
  CALL_ERASE_BATCH,
  CALL_GET,
  CALL_INSERT,
  CALL_JOB_CLAIM,
  CALL_JOB_COMPLETE,
  CALL_JOB_FAIL,
  CALL_JOB_GIVE_UP_SPENT,
  CALL_JOB_HEARTBEAT,
  CALL_JOB_MAX_ATTEMPTS,
  CALL_JOB_RECORD,
  CALL_JOB_RETRY,
  CALL_LIST,
  CALL_LIST_BY_DEAL,
  CALL_LIST_BY_DEAL_STATE,
  CALL_LIST_BY_STATE,
  CALL_LIST_PENDING_CLEANUP,
  CALL_LIST_SPENT_PURGES,
  CALL_PURGE_CLAIM,
  CALL_PURGE_COMPLETE,
  CALL_PURGE_MAX_ATTEMPTS,
  CALL_REQUEUE,
  CALL_RESTORE,
  CALL_RESTORE_FOR_UPLOAD,
  CALL_RETAGGED,
  CALL_SET_REP,
  CALL_SOFT_DELETE,
  CALL_USAGE,
  DEAL_ERASE_BATCH,
  DEAL_LIST_PENDING_RETAG,
  DEAL_RETAG_BATCH,
  DEAL_RETAG_DONE,
  DEAL_RETAG_LOCK,
  DEAL_SET_OUTCOME,
  ORGANIZATION_REMOVAL_STATUS,
  ORGANIZATION_REMOVE_REST,
  QUOTA_LOCK,
} from 'tula-closeline-db'
import { createFixedClock } from 'tula-closeline-kit'
import { toTextArrayLiteral } from '~/adapters/postgres/text-array'
import {
  createMemoryPlaybookDatabase,
  type MemoryCallRow,
  type MemoryDealRow,
} from './playbook-database'

const ORG = `org_${'a'.repeat(32)}`
const OTHER = `org_${'b'.repeat(32)}`
const USER = `usr_${'1'.repeat(32)}`
const call = (n: number) => `call_${n.toString(16).padStart(32, '0')}`
const job = (n: number) => `cjob_${n.toString(16).padStart(32, '0')}`
const record = (n: number) => `deal_${n.toString(16).padStart(32, '0')}`
const WORDING = 2
const labels = (values: string[]) => toTextArrayLiteral(values)

function setup() {
  const clock = createFixedClock(new Date('2026-01-01T00:00:00Z'))
  const db = createMemoryPlaybookDatabase({ clock })
  for (const organization of [ORG, OTHER]) {
    db.seedRights({
      organization_id: organization,
      confirmed_by: USER,
      confirmed_at: 0,
      wording_version: WORDING,
    })
  }
  return { db, clock }
}
type Db = ReturnType<typeof setup>['db']

/** Changes the first committed Call of ORG. A transaction commits a copy, so a row is never held across one. */
function patchCall(db: Db, patch: Partial<MemoryCallRow>): void {
  Object.assign(db.calls(ORG)[0] ?? {}, patch)
}

type InsertOptions = {
  n?: number
  deal?: string
  hash?: string
  organization?: string
  kind?: 'transcript' | 'recording'
  size?: number
  maxCalls?: number
  maxDeals?: number
  wording?: number
  lock?: boolean
  rep?: string | null
}

/** Runs CALL_INSERT in one transaction, with the upload lock unless asked otherwise. */
async function insert(db: Db, o: InsertOptions = {}) {
  const n = o.n ?? 1
  const organization = o.organization ?? ORG
  return db.scope(organization, async (run) => {
    if (o.lock !== false) {
      await run(QUOTA_LOCK, [organization])
    }
    const result = await run(CALL_INSERT, [
      organization,
      call(n),
      o.deal ?? 'DEAL-1',
      record(n),
      'notes.txt',
      'text/plain',
      o.kind ?? 'transcript',
      o.size ?? 100,
      Buffer.from((o.hash ?? `h${n}`).padEnd(32, '0')),
      USER,
      `calls/${call(n)}/original.txt`,
      'speaker',
      o.rep === undefined ? 'Rep' : o.rep,
      null,
      job(n),
      o.maxCalls ?? 2000,
      50 * 1024 ** 3,
      o.maxDeals ?? 20_000,
      o.wording ?? WORDING,
    ])
    return result.rows[0]
  })
}

/** Claims the oldest due job of an Organization; returns its claim row. */
async function claim(db: Db, organization = ORG, size = 5) {
  const result = await db.scope(organization, (run) =>
    run(CALL_JOB_CLAIM, [organization, size, 60_000, null])
  )
  return result.rows.filter((r) => r.id !== null)
}

describe('CALL_INSERT answers the five results of the README', () => {
  test('created: a Call in uploaded, a queued process job, an open Deal made on the way', async () => {
    const { db } = setup()

    const answer = await insert(db)

    expect(answer).toEqual({
      result: 'created',
      id: call(1),
      state: 'uploaded',
      failure_reason: null,
    })
    expect(db.calls(ORG)[0]).toMatchObject({ state: 'uploaded', epoch: 0, rep_seq: 0 })
    expect(db.callJobs(ORG)).toMatchObject([{ kind: 'process', state: 'queued', epoch: 0 }])
    expect(db.deals(ORG)).toMatchObject([{ deal_id: 'DEAL-1', outcome: 'open', outcome_seq: 0 }])
  })

  test('a second Call of the same Deal reuses the Deal', async () => {
    const { db } = setup()
    await insert(db)

    await insert(db, { n: 2 })

    expect(db.deals(ORG)).toHaveLength(1)
  })

  test('existing: the same content under the same Deal returns the stored Call; other_deal: under another says nothing of it', async () => {
    const { db } = setup()
    await insert(db)

    const same = await insert(db, { n: 2, hash: 'h1' })
    const other = await insert(db, { n: 3, hash: 'h1', deal: 'DEAL-2' })

    expect(same).toEqual({
      result: 'existing',
      id: call(1),
      state: 'uploaded',
      failure_reason: null,
    })
    expect(other).toEqual({ result: 'other_deal', id: null, state: null, failure_reason: null })
    expect(db.calls(ORG)).toHaveLength(1)
    expect(db.deals(ORG)).toHaveLength(1)
  })

  test('rights_required: no confirmation at exactly this wording version, whatever else is true', async () => {
    const { db } = setup()

    const outdated = await insert(db, { wording: WORDING + 1 })

    expect(outdated?.result).toBe('rights_required')
    expect(db.calls(ORG)).toEqual([])
    expect(db.deals(ORG)).toEqual([])
  })

  test('quota_exceeded: too many Calls, or too many Deals for a new one', async () => {
    const { db } = setup()
    await insert(db)

    const calls = await insert(db, { n: 2, maxCalls: 1 })
    const deals = await insert(db, { n: 3, deal: 'DEAL-9', maxDeals: 1 })
    const known = await insert(db, { n: 4, maxDeals: 1 })

    expect(calls?.result).toBe('quota_exceeded')
    expect(deals?.result).toBe('quota_exceeded')
    expect(known?.result).toBe('created')
  })

  test('the upload lock is required to write, as Postgres requires it', async () => {
    const { db } = setup()

    await expect(insert(db, { lock: false })).rejects.toMatchObject({
      code: '55000',
      message: expect.stringContaining('playbook.upload_lock'),
    })
    expect(db.calls(ORG)).toEqual([])
  })

  test('another Organization has its own Calls, Deals and duplicate rule', async () => {
    const { db } = setup()
    await insert(db)

    const other = await insert(db, { organization: OTHER, n: 2, hash: 'h1' })

    expect(other?.result).toBe('created')
    expect(db.calls(OTHER)).toHaveLength(1)
  })
})

describe('reading Calls', () => {
  test('CALL_GET joins the Deal and derives in_search from state, Outcome and tag', async () => {
    const { db } = setup()
    await insert(db)
    const read = async () => (await db.scope(ORG, (run) => run(CALL_GET, [ORG, call(1)]))).rows[0]
    // A transaction commits a copy, so the rows are read again before each change.
    const change = (patch: Partial<MemoryCallRow>, deal: Partial<MemoryDealRow> = {}) => {
      patchCall(db, patch)
      Object.assign(db.deals(ORG)[0] ?? {}, deal)
    }
    expect(await read()).toMatchObject({
      deal_id: 'DEAL-1',
      deal_outcome: 'open',
      in_search: false,
    })

    change({ state: 'ready', tagged_outcome_seq: 1 }, { outcome: 'won', outcome_seq: 2 })
    expect(await read()).toMatchObject({ in_search: false })
    change({ tagged_outcome_seq: 2 })
    expect(await read()).toMatchObject({ in_search: true })
    expect((await db.scope(OTHER, (run) => run(CALL_GET, [OTHER, call(1)]))).rows).toEqual([])
  })

  test('the four lists page newest first by a text cursor and keep their filters', async () => {
    const { db } = setup()
    for (const n of [1, 2, 3]) {
      await insert(db, { n, deal: n === 3 ? 'DEAL-B' : 'DEAL-A' })
    }
    Object.assign(db.calls(ORG)[1] ?? {}, { state: 'failed' })
    const deal = db.deals(ORG).find((d) => d.deal_id === 'DEAL-A')
    const list = (statement: string, extra: unknown[] = []) =>
      db.scope(ORG, (run) => run(statement, [ORG, 'infinity', '', 2, ...extra]))

    const first = await list(CALL_LIST)
    const next = await db.scope(ORG, (run) =>
      run(CALL_LIST, [ORG, first.rows[1]?.cursor_at, first.rows[1]?.id, 2])
    )

    expect(first.rows.map((r) => r.id)).toEqual([call(3), call(2)])
    expect(next.rows.map((r) => r.id)).toEqual([call(1)])
    expect((await list(CALL_LIST_BY_STATE, ['failed'])).rows.map((r) => r.id)).toEqual([call(2)])
    expect((await list(CALL_LIST_BY_DEAL, [deal?.id])).rows.map((r) => r.id)).toEqual([
      call(2),
      call(1),
    ])
    expect(
      (await list(CALL_LIST_BY_DEAL_STATE, [deal?.id, 'failed'])).rows.map((r) => r.id)
    ).toEqual([call(2)])
    expect(
      (await db.scope(OTHER, (run) => run(CALL_LIST, [OTHER, 'infinity', '', 5]))).rows
    ).toEqual([])
  })

  test('a deleted Call is left out of the default list', async () => {
    const { db } = setup()
    await insert(db)
    patchCall(db, { state: 'deleted' })

    const listed = await db.scope(ORG, (run) => run(CALL_LIST, [ORG, 'infinity', '', 5]))

    expect(listed.rows).toEqual([])
  })

  test('a malformed cursor is SQLSTATE 22007', async () => {
    const { db } = setup()

    await expect(
      db.scope(ORG, (run) => run(CALL_LIST, [ORG, 'not a time', '', 5]))
    ).rejects.toMatchObject({ code: expect.stringMatching(/^22/) })
  })
})

describe('re-uploading content that is already stored', () => {
  test('CALL_REQUEUE re-queues a failed Call only for a transient reason', async () => {
    const { db } = setup()
    await insert(db)
    patchCall(db, { state: 'failed', failure_reason: 'unreadable' })
    const requeue = (n: number) => db.scope(ORG, (run) => run(CALL_REQUEUE, [ORG, call(1), job(n)]))

    const fixed = await requeue(2)
    patchCall(db, { failure_reason: 'processing_failed' })
    const transient = await requeue(3)

    expect(fixed.rows[0]).toMatchObject({ state: 'failed', changed: false })
    expect(transient.rows[0]).toMatchObject({ state: 'uploaded', changed: true, epoch: 1 })
    expect(db.calls(ORG)[0]?.state).toBe('uploaded')
    expect(db.callJobs(ORG).filter((j) => j.state === 'queued')).toHaveLength(1)
  })

  test('CALL_RESTORE_FOR_UPLOAD restores a deleted Call to processing with a new job and epoch', async () => {
    const { db } = setup()
    await insert(db)
    patchCall(db, { state: 'deleted', deleted_at: 1, purge_due_at: 2 })

    const restored = await db.scope(ORG, (run) =>
      run(CALL_RESTORE_FOR_UPLOAD, [ORG, call(1), job(2)])
    )

    expect(restored.rows[0]).toMatchObject({ state: 'processing', changed: true, epoch: 1 })
    expect(db.calls(ORG)[0]).toMatchObject({ deleted_at: null, purge_due_at: null })
    expect(db.callJobs(ORG).some((j) => j.id === job(2) && j.state === 'queued')).toBe(true)
  })

  test('a barred Call is not restored', async () => {
    const { db } = setup()
    await insert(db)
    patchCall(db, { state: 'deleted', restore_barred_at: 1 })

    const restored = await db.scope(ORG, (run) =>
      run(CALL_RESTORE_FOR_UPLOAD, [ORG, call(1), job(2)])
    )

    expect(restored.rows).toEqual([])
  })
})

describe('the job statements', () => {
  test('CALL_JOB_CLAIM leases a due job, moves the Call to processing and returns what the job reads', async () => {
    const { db } = setup()
    await insert(db)

    const claimed = await claim(db)

    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({
      call_id: call(1),
      job_kind: 'process',
      attempts: 1,
      call_kind: 'transcript',
      rep_by: 'speaker',
      rep_label: 'Rep',
    })
    expect(db.calls(ORG)[0]?.state).toBe('processing')
    expect(await claim(db)).toEqual([])
  })

  test('a job whose Call moved on (a new epoch) is cancelled, not run', async () => {
    const { db } = setup()
    await insert(db)
    patchCall(db, { epoch: 1 })

    const claimed = await claim(db)

    expect(claimed).toEqual([])
    expect(db.callJobs(ORG)[0]?.state).toBe('cancelled')
  })

  test('a job out of attempts is never claimed', async () => {
    const { db } = setup()
    await insert(db)
    Object.assign(db.callJobs(ORG)[0] ?? {}, { attempts: CALL_JOB_MAX_ATTEMPTS })

    expect(await claim(db)).toEqual([])
  })

  test('heartbeat, retry and record act only for the holder of the claim token', async () => {
    const { db } = setup()
    await insert(db)
    const [claimed] = await claim(db)
    const id = String(claimed?.id)
    const token = String(claimed?.claim_token)
    const wrong = crypto.randomUUID()
    const run = (statement: string, params: unknown[]) => db.scope(ORG, (r) => r(statement, params))

    expect((await run(CALL_JOB_HEARTBEAT, [ORG, id, wrong, 60_000])).rows).toEqual([])
    expect((await run(CALL_JOB_HEARTBEAT, [ORG, id, token, 60_000])).rows).toHaveLength(1)
    expect(
      (await run(CALL_JOB_RECORD, [ORG, id, wrong, null, null, labels(['Rep']), 60_000])).rows
    ).toEqual([])
    await run(CALL_JOB_RECORD, [ORG, id, token, null, null, labels(['Rep', 'Prospect']), 60_000])
    expect(db.calls(ORG)[0]?.speaker_labels).toEqual(['Rep', 'Prospect'])
    const retried = await run(CALL_JOB_RETRY, [ORG, id, token, 5000])
    expect(retried.rows[0]).toMatchObject({ id, attempts: 1 })
    expect(db.callJobs(ORG)[0]).toMatchObject({ state: 'queued', claim_token: null })
  })

  test('CALL_JOB_COMPLETE makes the Call ready and tags it with the Outcome sequence', async () => {
    const { db } = setup()
    await insert(db)
    const [claimed] = await claim(db)
    const id = String(claimed?.id)
    const token = String(claimed?.claim_token)
    await db.scope(ORG, (run) =>
      run(CALL_JOB_RECORD, [ORG, id, token, null, null, labels(['Rep', 'Prospect']), 60_000])
    )
    // retag_through 3: the Deal was fully re-tagged at its sequence, so a Call finishing at 2 lowers it.
    Object.assign(db.deals(ORG)[0] ?? {}, { outcome: 'won', outcome_seq: 3, retag_through: 3 })

    const done = await db.scope(ORG, (run) => run(CALL_JOB_COMPLETE, [ORG, id, token, 2]))

    expect(done.rows).toHaveLength(1)
    expect(db.calls(ORG)[0]).toMatchObject({ state: 'ready', tagged_outcome_seq: 2 })
    expect(db.callJobs(ORG)[0]?.state).toBe('succeeded')
    // A Deal that moved on while the job ran is found by the re-tag.
    expect(db.deals(ORG)[0]?.retag_through).toBe(2)
  })

  test('CALL_JOB_COMPLETE refuses a Rep label that is not among the speakers', async () => {
    const { db } = setup()
    await insert(db)
    const [claimed] = await claim(db)
    const id = String(claimed?.id)
    const token = String(claimed?.claim_token)
    await db.scope(ORG, (run) =>
      run(CALL_JOB_RECORD, [ORG, id, token, null, null, labels(['Someone']), 60_000])
    )

    const done = await db.scope(ORG, (run) => run(CALL_JOB_COMPLETE, [ORG, id, token, 0]))

    expect(done.rows).toEqual([])
    expect(db.calls(ORG)[0]?.state).toBe('processing')
  })

  test('CALL_JOB_FAIL fails the Call with the reason and clears the speakers for too many', async () => {
    const { db } = setup()
    await insert(db)
    const [claimed] = await claim(db)
    const id = String(claimed?.id)
    const token = String(claimed?.claim_token)

    await db.scope(ORG, (run) => run(CALL_JOB_FAIL, [ORG, id, token, 'no_turns']))

    expect(db.calls(ORG)[0]).toMatchObject({ state: 'failed', failure_reason: 'no_turns' })
    expect(db.callJobs(ORG)[0]).toMatchObject({ state: 'failed' })
  })

  test('CALL_JOB_GIVE_UP_SPENT fails the Call of a job that used all its attempts', async () => {
    const { db } = setup()
    await insert(db)
    Object.assign(db.callJobs(ORG)[0] ?? {}, { attempts: CALL_JOB_MAX_ATTEMPTS })

    const spent = await db.scope(ORG, (run) => run(CALL_JOB_GIVE_UP_SPENT, [ORG, 10]))

    expect(spent.rows).toEqual([{ call_id: call(1) }])
    expect(db.calls(ORG)[0]).toMatchObject({ state: 'failed', failure_reason: 'processing_failed' })
  })

  test('another Organization cannot claim or finish the job', async () => {
    const { db } = setup()
    await insert(db)

    expect(await claim(db, OTHER)).toEqual([])
    const [claimed] = await claim(db)
    const done = await db.scope(OTHER, (run) =>
      run(CALL_JOB_COMPLETE, [OTHER, claimed?.id, claimed?.claim_token, 0])
    )
    expect(done.rows).toEqual([])
  })
})

describe('erasure and purge', () => {
  async function erased(db: Db) {
    await insert(db)
    return db.scope(ORG, (run) => run(CALL_ERASE_BATCH, [ORG, 10, USER]))
  }

  test('CALL_ERASE_BATCH deletes at once, bars restore, cancels the job and returns the keys', async () => {
    const { db } = setup()

    const result = await erased(db)

    expect(result.rows[0]).toMatchObject({
      id: call(1),
      changed: true,
      deletion_seq: 1,
      object_key: `calls/${call(1)}/original.txt`,
    })
    expect(db.calls(ORG)[0]).toMatchObject({ state: 'deleted' })
    expect(db.calls(ORG)[0]?.restore_barred_at).not.toBeNull()
    expect(db.callJobs(ORG)[0]?.state).toBe('cancelled')
    const again = await db.scope(ORG, (run) => run(CALL_ERASE_BATCH, [ORG, 10, USER]))
    expect(again.rows).toEqual([])
  })

  test('the purge needs the cleanup recorded, then completes and removes the row and its jobs', async () => {
    const { db } = setup()
    await erased(db)
    const claimed = await db.scope(ORG, (run) => run(CALL_PURGE_CLAIM, [ORG, 5, 60_000]))
    const early = await db.scope(ORG, (run) => run(CALL_PURGE_COMPLETE, [ORG, call(1)]))
    const begin = await db.scope(ORG, (run) => run(CALL_CLEANUP_BEGIN, [ORG, call(1), 1]))
    const done = await db.scope(ORG, (run) => run(CALL_CLEANUP_DONE, [ORG, call(1), 1]))
    const complete = await db.scope(ORG, (run) => run(CALL_PURGE_COMPLETE, [ORG, call(1)]))

    expect(claimed.rows[0]).toMatchObject({ id: call(1), purge_attempts: 1 })
    expect(early.rows).toEqual([])
    expect(begin.rows[0]).toMatchObject({ id: call(1), clear: true })
    expect(done.rows).toHaveLength(1)
    expect(complete.rows[0]).toMatchObject({ id: call(1), size_bytes: 100 })
    expect(db.calls(ORG)).toEqual([])
    expect(db.callJobs(ORG)).toEqual([])
  })

  test('a claim waits for a running job lease and is not handed out twice', async () => {
    const { db } = setup()
    await insert(db)
    await claim(db)
    await db.scope(ORG, (run) => run(CALL_ERASE_BATCH, [ORG, 10, USER]))

    const waiting = await db.scope(ORG, (run) => run(CALL_PURGE_CLAIM, [ORG, 5, 60_000]))
    expect(waiting.rows).toEqual([])
    expect(
      (await db.scope(ORG, (run) => run(CALL_CLEANUP_BEGIN, [ORG, call(1), 1]))).rows[0]
    ).toMatchObject({ clear: false })
  })

  test('CALL_LIST_PENDING_CLEANUP lists deleted Calls without a recorded cleanup, until it is recorded', async () => {
    const { db } = setup()
    await erased(db)
    const list = () =>
      db.scope(ORG, (run) => run(CALL_LIST_PENDING_CLEANUP, [ORG, '-infinity', '', 10]))

    expect((await list()).rows.map((r) => r.id)).toEqual([call(1)])
    await db.scope(ORG, (run) => run(CALL_CLEANUP_DONE, [ORG, call(1), 1]))
    expect((await list()).rows).toEqual([])
  })

  test('CALL_LIST_SPENT_PURGES lists a purge that used all its attempts', async () => {
    const { db } = setup()
    await erased(db)
    patchCall(db, { purge_attempts: CALL_PURGE_MAX_ATTEMPTS })

    const spent = await db.scope(ORG, (run) => run(CALL_LIST_SPENT_PURGES, [ORG, '', 10]))

    expect(spent.rows.map((r) => r.id)).toEqual([call(1)])
    expect((await db.scope(ORG, (run) => run(CALL_PURGE_CLAIM, [ORG, 5, 60_000]))).rows).toEqual([])
  })

  test('the removal status and the rest wait for Calls, and Deals cannot be erased under a Call', async () => {
    const { db } = setup()
    await insert(db)

    const status = await db.scope(ORG, (run) => run(ORGANIZATION_REMOVAL_STATUS, [ORG]))
    const rest = await db.scope(ORG, (run) => run(ORGANIZATION_REMOVE_REST, [ORG, 'x']))

    expect(status.rows[0]).toMatchObject({ no_calls: false, removed: false })
    expect(rest.rows[0]).toMatchObject({ removed: false })
    await expect(db.scope(ORG, (run) => run(DEAL_ERASE_BATCH, [ORG, 10]))).rejects.toMatchObject({
      code: '23503',
    })
  })
})

describe('a text-array parameter', () => {
  test('a JavaScript array is refused as Postgres refuses it, and a literal round-trips awkward labels', async () => {
    const { db } = setup()
    await insert(db)
    const [claimed] = await claim(db)
    const id = String(claimed?.id)
    const token = String(claimed?.claim_token)
    const run = (statement: string, params: unknown[]) => db.scope(ORG, (r) => r(statement, params))

    await expect(
      run(CALL_JOB_RECORD, [ORG, id, token, null, null, ['Rep', 'Prospect'], 60_000])
    ).rejects.toMatchObject({ code: '42846' })
    const awkward = ['A "q"', 'b\\c', 'x,y', '']
    await run(CALL_JOB_RECORD, [ORG, id, token, null, null, toTextArrayLiteral(awkward), 60_000])
    expect(db.calls(ORG)[0]?.speaker_labels).toEqual(awkward)
  })
})

/** A ready Call with the speakers Rep and Prospect, ready for the Rep, delete and re-tag statements. */
async function readyCall(db: Db) {
  await insert(db)
  patchCall(db, {
    state: 'ready',
    speaker_labels: ['Rep', 'Prospect'],
    rep_by: 'speaker',
    rep_label: 'Rep',
  })
  Object.assign(db.callJobs(ORG)[0] ?? {}, { state: 'succeeded' })
}

const run = (db: Db, statement: string, params: unknown[], organization = ORG) =>
  db.scope(organization, (r) => r(statement, params))

describe('CALL_SET_REP', () => {
  test('changed: bumps rep_seq, cancels the live job keeping a running lease, queues a rebuild', async () => {
    const { db } = setup()
    await readyCall(db)

    const answer = (
      await run(db, CALL_SET_REP, [ORG, call(1), 'speaker', 'Prospect', null, job(9)])
    ).rows[0]

    expect(answer).toEqual({ result: 'changed', id: call(1), state: 'processing', rep_seq: 1 })
    expect(db.calls(ORG)[0]).toMatchObject({ rep_label: 'Prospect', state: 'processing' })
    expect(db.callJobs(ORG).find((j) => j.id === job(9))).toMatchObject({
      kind: 'rebuild',
      rep_seq: 1,
      state: 'queued',
    })
  })

  test('unchanged, invalid and not_changeable are answered without a write', async () => {
    const { db } = setup()
    await readyCall(db)
    const set = async (by: string | null, label: string | null, channel: string | null = null) =>
      (await run(db, CALL_SET_REP, [ORG, call(1), by, label, channel, job(9)])).rows[0]?.result

    expect(await set('speaker', 'Rep')).toBe('unchanged')
    expect(await set('speaker', 'Nobody')).toBe('invalid')
    expect(await set('channel', null, 'left')).toBe('invalid')
    expect(await set(null, null)).toBe('invalid')
    patchCall(db, { state: 'processing' })
    expect(await set('speaker', 'Prospect')).toBe('not_changeable')
    patchCall(db, { state: 'failed', failure_reason: 'too_few_speakers' })
    expect(await set('speaker', 'Prospect')).toBe('not_changeable')
    expect(db.callJobs(ORG)).toHaveLength(1)
    expect(db.calls(ORG)[0]?.rep_seq).toBe(0)
  })

  test('a Call failed with rep_label_not_found can be fixed from the labels it holds', async () => {
    const { db } = setup()
    await insert(db)
    patchCall(db, {
      state: 'failed',
      failure_reason: 'rep_label_not_found',
      speaker_labels: ['Rep', 'Prospect'],
    })

    const answer = (
      await run(db, CALL_SET_REP, [ORG, call(1), 'speaker', 'Prospect', null, job(9)])
    ).rows[0]

    expect(answer?.result).toBe('changed')
    expect(db.calls(ORG)[0]).toMatchObject({ state: 'processing', failure_reason: null })
  })

  test('another Organization finds no Call', async () => {
    const { db } = setup()
    await readyCall(db)

    expect(
      (await run(db, CALL_SET_REP, [OTHER, call(1), 'speaker', 'Rep', null, job(9)], OTHER)).rows
    ).toEqual([])
  })
})

describe('CALL_SOFT_DELETE and CALL_RESTORE', () => {
  test('delete bumps epoch and deletion_seq once and cancels the job; a repeat changes nothing; the quota still counts it', async () => {
    const { db } = setup()
    await insert(db)

    const first = (await run(db, CALL_SOFT_DELETE, [ORG, call(1), USER, 1000])).rows[0]
    const again = (await run(db, CALL_SOFT_DELETE, [ORG, call(1), USER, 1000])).rows[0]

    expect(first).toMatchObject({ state: 'deleted', deletion_seq: 1, changed: true })
    expect(again).toMatchObject({ deletion_seq: 1, changed: false })
    expect(db.calls(ORG)[0]).toMatchObject({ epoch: 1 })
    // The retention is raised to one hour.
    expect(db.calls(ORG)[0]?.purge_due_at).toBeGreaterThanOrEqual(3_600_000)
    expect(db.callJobs(ORG)[0]?.state).toBe('cancelled')
    expect((await run(db, CALL_USAGE, [ORG])).rows[0]).toMatchObject({ call_count: 1 })
  })

  test('restore brings it back processing with a process job at the new epoch, and a repeat changes nothing', async () => {
    const { db } = setup()
    await readyCall(db)
    await run(db, CALL_SOFT_DELETE, [ORG, call(1), USER, 3_600_000])

    const restored = (await run(db, CALL_RESTORE, [ORG, call(1), job(5)])).rows[0]
    const again = (await run(db, CALL_RESTORE, [ORG, call(1), job(6)])).rows[0]

    expect(restored).toMatchObject({ state: 'processing', epoch: 2, changed: true })
    expect(again).toMatchObject({ changed: false })
    expect(db.callJobs(ORG).filter((j) => j.state === 'queued')).toMatchObject([
      { id: job(5), kind: 'process', epoch: 2 },
    ])
  })

  test('restore gives no row once the purge time passed, the purge started or erasure barred it', async () => {
    const { db, clock } = setup()
    await readyCall(db)
    await run(db, CALL_SOFT_DELETE, [ORG, call(1), USER, 3_600_000])
    clock.advance('2h')
    expect((await run(db, CALL_RESTORE, [ORG, call(1), job(5)])).rows).toEqual([])
    patchCall(db, { purge_due_at: clock.now().getTime() + 1_000_000, purge_started_at: 1 })
    expect((await run(db, CALL_RESTORE, [ORG, call(1), job(5)])).rows).toEqual([])
    patchCall(db, { purge_started_at: null, restore_barred_at: 1 })
    expect((await run(db, CALL_RESTORE, [ORG, call(1), job(5)])).rows).toEqual([])
  })
})

describe('the re-tag statements', () => {
  const setOutcome = (db: Db, outcome: string) =>
    run(db, DEAL_SET_OUTCOME, [ORG, db.deals(ORG)[0]?.id, outcome, null, false])

  test('a Deal is pending while retag_through lags; the batch lists its stale ready Calls; CALL_RETAGGED takes a text-array literal only', async () => {
    const { db } = setup()
    await readyCall(db)
    await setOutcome(db, 'won')
    const dealId = String(db.deals(ORG)[0]?.id)

    expect((await run(db, DEAL_LIST_PENDING_RETAG, [ORG, '', 10])).rows).toMatchObject([
      { id: dealId, outcome: 'won', outcome_seq: 1, retag_through: 0 },
    ])
    expect((await run(db, DEAL_RETAG_BATCH, [ORG, dealId, '', 10])).rows).toMatchObject([
      { id: call(1), outcome: 'won', outcome_seq: 1 },
    ])
    await expect(run(db, CALL_RETAGGED, [ORG, [call(1)], 1])).rejects.toMatchObject({
      code: '42846',
    })
    expect((await run(db, CALL_RETAGGED, [ORG, toTextArrayLiteral([call(1)]), 1])).rows).toEqual([
      { id: call(1) },
    ])
    expect((await run(db, DEAL_RETAG_BATCH, [ORG, dealId, '', 10])).rows).toEqual([])
    // Not above the Deal's sequence, and not a second time.
    expect((await run(db, CALL_RETAGGED, [ORG, toTextArrayLiteral([call(1)]), 5])).rows).toEqual([])
  })

  test("DONE refuses while a ready Call is stale or the sequence is not the Deal's, and accepts once tagged", async () => {
    const { db } = setup()
    await readyCall(db)
    await setOutcome(db, 'won')
    const dealId = String(db.deals(ORG)[0]?.id)

    expect((await run(db, DEAL_RETAG_DONE, [ORG, dealId, 1])).rows).toEqual([])
    await run(db, CALL_RETAGGED, [ORG, toTextArrayLiteral([call(1)]), 1])
    expect((await run(db, DEAL_RETAG_DONE, [ORG, dealId, 2])).rows).toEqual([])
    expect((await run(db, DEAL_RETAG_DONE, [ORG, dealId, 1])).rows).toMatchObject([
      { retag_through: 1, outcome_seq: 1 },
    ])
    expect((await run(db, DEAL_RETAG_LOCK, [ORG, dealId])).rows[0]).toMatchObject({
      retag_through: 1,
    })
    expect((await run(db, DEAL_LIST_PENDING_RETAG, [ORG, '', 10])).rows).toEqual([])
  })

  test('another Organization sees no pending Deal', async () => {
    const { db } = setup()
    await readyCall(db)
    await setOutcome(db, 'won')
    expect((await run(db, DEAL_LIST_PENDING_RETAG, [OTHER, '', 10], OTHER)).rows).toEqual([])
  })
})
