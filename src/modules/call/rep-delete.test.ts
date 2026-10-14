import { describe, expect, test } from 'bun:test'
import { callSchema } from 'tula-closeline-contract'
import { CALL_USAGE } from 'tula-closeline-db'
import { errorCode, personIn } from '~/modules/document/test-support'
import { cleanupPendingCalls, purgeCalls } from './purge'
import { type CallHarness, createCallHarness, transcriptText } from './test-support'

const abort = () => new AbortController().signal
const DAY = 24 * 3600_000

async function readyCall(h: CallHarness, seed: string, options: { rep?: string | null } = {}) {
  const response = await h.uploadCall(transcriptText(seed, 2), { dealId: 'DEAL-1', ...options })
  expect(response.status).toBe(201)
  const call = callSchema.parse(await response.json())
  await h.runCalls()
  return call
}

const rowOf = (h: CallHarness, id: string) => {
  const row = h.deps.database.calls(h.organizationId).find((c) => c.id === id)
  if (row === undefined) {
    throw new Error('no Call')
  }
  return row
}

const vectorsOf = async (h: CallHarness, callId: string) =>
  (
    await h.deps.vectors.search(h.organizationId, {
      vector: new Array<number>(h.deps.vectors.dimensions).fill(0.1),
      topK: 100,
      filter: { call_id: callId },
    })
  ).map((hit) => hit.attributes)

const putRep = (
  h: CallHarness,
  id: string,
  rep: unknown,
  as?: Parameters<CallHarness['send']>[2]
) => h.send('PUT', `/v1/playbook/calls/${id}/rep`, { body: { rep }, ...as })

describe('changing the Rep of a Call', () => {
  test('a different Rep rebuilds the Moments under a new rep_seq and removes the old vectors', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    const before = h.published.length

    const response = await putRep(h, call.id, { by: 'speaker', label: 'Sam' })

    expect(response.status).toBe(200)
    expect(callSchema.parse(await response.json()).state).toBe('processing')
    expect(rowOf(h, call.id).rep_seq).toBe(1)
    expect(h.published.slice(before).map((m) => m.type)).toEqual(['playbook.call_rep_changed'])
    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('ready')
    const attrs = await vectorsOf(h, call.id)
    expect(attrs.length).toBeGreaterThan(0)
    expect(new Set(attrs.map((a) => a?.rep_seq))).toEqual(new Set([1]))
  })

  test('the same Rep again changes nothing and publishes nothing', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    const before = h.published.length

    const response = await putRep(h, call.id, { by: 'speaker', label: 'Alex' })

    expect(response.status).toBe(200)
    expect((await h.readCall(call.id)).state).toBe('ready')
    expect(rowOf(h, call.id).rep_seq).toBe(0)
    expect(h.published.length).toBe(before)
  })

  test('two changes in a row leave only the newest rep_seq behind, and one while processing is refused', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')

    expect((await putRep(h, call.id, { by: 'speaker', label: 'Sam' })).status).toBe(200)
    const busy = await putRep(h, call.id, { by: 'speaker', label: 'Alex' })
    expect(busy.status).toBe(409)
    expect(await errorCode(busy)).toBe('call.rep_not_changeable')
    await h.runCalls()
    expect((await putRep(h, call.id, { by: 'speaker', label: 'Alex' })).status).toBe(200)
    await h.runCalls()

    expect((await h.readCall(call.id)).state).toBe('ready')
    const seqs = new Set((await vectorsOf(h, call.id)).map((a) => a?.rep_seq))
    expect(seqs).toEqual(new Set([2]))
  })

  test('a change attempted while the rebuild is writing is refused and the rebuild finishes alone', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    expect((await putRep(h, call.id, { by: 'speaker', label: 'Sam' })).status).toBe(200)
    const embed = h.deps.embedder.embed.bind(h.deps.embedder)
    let refused = 0
    h.deps.embedder.embed = async (...args) => {
      refused = (await putRep(h, call.id, { by: 'speaker', label: 'Alex' })).status
      return embed(...args)
    }

    await h.runCalls()

    expect(refused).toBe(409)
    expect((await h.readCall(call.id)).state).toBe('ready')
    expect(new Set((await vectorsOf(h, call.id)).map((a) => a?.rep_seq))).toEqual(new Set([1]))
  })

  test('a Call that failed because its Rep label was not found is fixed by choosing a label it has', async () => {
    const h = await createCallHarness()
    const response = await h.uploadCall(transcriptText('f', 2), {
      dealId: 'DEAL-1',
      rep: JSON.stringify({ by: 'speaker', label: 'Nobody' }),
    })
    const call = callSchema.parse(await response.json())
    await h.runCalls()
    const failed = await h.readCall(call.id)
    expect(failed).toMatchObject({ state: 'failed', failureReason: 'rep_label_not_found' })
    expect(failed.speakerLabels).toEqual(expect.arrayContaining(['Alex', 'Sam']))

    expect((await putRep(h, call.id, { by: 'speaker', label: 'Alex' })).status).toBe(200)
    await h.runCalls()

    expect(await h.readCall(call.id)).toMatchObject({ state: 'ready', failureReason: null })
    expect((await vectorsOf(h, call.id)).length).toBeGreaterThan(0)
  })

  test('a label the Call does not have is call.rep_invalid and a gone Call is call.not_found', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')

    const invalid = await putRep(h, call.id, { by: 'speaker', label: 'Nobody' })
    expect(invalid.status).toBe(422)
    expect(await errorCode(invalid)).toBe('call.rep_invalid')
    const missing = await putRep(h, `call_${'a'.repeat(32)}`, { by: 'speaker', label: 'Alex' })
    expect(missing.status).toBe(404)
    expect(await errorCode(missing)).toBe('call.not_found')
  })

  test('a deleted Call cannot have its Rep changed', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    expect((await h.send('DELETE', `/v1/playbook/calls/${call.id}`)).status).toBe(200)

    const response = await putRep(h, call.id, { by: 'speaker', label: 'Sam' })

    expect(await errorCode(response)).toBe('call.rep_not_changeable')
  })

  test('only an Owner or Admin may change it, and another Organization sees a 404', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')

    for (const role of ['manager', 'rep'] as const) {
      const response = await putRep(
        h,
        call.id,
        { by: 'speaker', label: 'Sam' },
        { as: h.people[role] }
      )
      expect(response.status).toBe(403)
    }
    const stranger = personIn(`org_${'9'.repeat(32)}`, 'owner')
    const other = await putRep(h, call.id, { by: 'speaker', label: 'Sam' }, { as: stranger })
    expect(other.status).toBe(404)
    expect(rowOf(h, call.id).rep_seq).toBe(0)
  })
})

describe('deleting and restoring a Call', () => {
  test('a deleted Call is hidden from the list, its vectors go after the cleanup, and the count is kept', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    const before = h.published.length

    const response = await h.send('DELETE', `/v1/playbook/calls/${call.id}`)

    expect(response.status).toBe(200)
    expect(callSchema.parse(await response.json())).toMatchObject({
      state: 'deleted',
      inSearch: false,
    })
    expect(h.published.slice(before).map((m) => m.type)).toEqual(['playbook.call_deleted'])
    expect((await h.listAll()).map((c) => c.id)).not.toContain(call.id)
    expect((await h.listAll('state=deleted')).map((c) => c.id)).toContain(call.id)
    const again = await h.send('DELETE', `/v1/playbook/calls/${call.id}`)
    expect(again.status).toBe(200)
    expect(h.published.length).toBe(before + 1)

    await h.deps.time.advance(10 * 60_000)
    await cleanupPendingCalls(h.deps, h.organizationId, abort())
    expect(await vectorsOf(h, call.id)).toEqual([])
    const usage = await h.deps.scope(h.organizationId, (run) => run(CALL_USAGE, [h.organizationId]))
    expect(Number(usage.rows[0]?.call_count)).toBe(1)
  })

  test('the purge, not the delete, gives the Call back to the quota', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    await h.send('DELETE', `/v1/playbook/calls/${call.id}`)
    await h.deps.time.advance(31 * DAY)

    await purgeCalls(h.deps, h.organizationId, abort())

    const usage = await h.deps.scope(h.organizationId, (run) => run(CALL_USAGE, [h.organizationId]))
    expect(Number(usage.rows[0]?.call_count ?? 0)).toBe(0)
  })

  test('a restore brings the Call back processing and it is searchable again once processed', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    await h.send('DELETE', `/v1/playbook/calls/${call.id}`)
    await h.deps.time.advance(10 * 60_000)
    await cleanupPendingCalls(h.deps, h.organizationId, abort())

    const response = await h.send('POST', `/v1/playbook/calls/${call.id}/restore`)

    expect(response.status).toBe(200)
    expect(callSchema.parse(await response.json()).state).toBe('processing')
    await h.runCalls()
    expect((await h.readCall(call.id)).state).toBe('ready')
    expect((await vectorsOf(h, call.id)).length).toBeGreaterThan(0)
    expect(new Set((await vectorsOf(h, call.id)).map((a) => a?.epoch))).toEqual(
      new Set([rowOf(h, call.id).epoch])
    )
  })

  test('a restore before the cleanup finished is safe: the cleanup removes only the older epoch', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    await h.send('DELETE', `/v1/playbook/calls/${call.id}`)

    expect((await h.send('POST', `/v1/playbook/calls/${call.id}/restore`)).status).toBe(200)
    await h.runCalls()
    await h.deps.time.advance(10 * 60_000)
    await cleanupPendingCalls(h.deps, h.organizationId, abort())

    expect((await h.readCall(call.id)).state).toBe('ready')
    expect((await vectorsOf(h, call.id)).length).toBeGreaterThan(0)
  })

  test('restoring a Call that is not deleted answers it as it is', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')

    const response = await h.send('POST', `/v1/playbook/calls/${call.id}/restore`)

    expect(response.status).toBe(200)
    expect(callSchema.parse(await response.json()).state).toBe('ready')
  })

  test('past the purge time a Call is call.not_restorable, and an unknown one call.not_found', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    await h.send('DELETE', `/v1/playbook/calls/${call.id}`)
    await h.deps.time.advance(31 * DAY)

    const late = await h.send('POST', `/v1/playbook/calls/${call.id}/restore`)
    expect(late.status).toBe(410)
    expect(await errorCode(late)).toBe('call.not_restorable')
    const unknown = await h.send('POST', `/v1/playbook/calls/call_${'b'.repeat(32)}/restore`)
    expect(await errorCode(unknown)).toBe('call.not_found')
  })

  test('only an Owner or Admin may delete or restore, and another Organization sees a 404', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    const stranger = personIn(`org_${'9'.repeat(32)}`, 'owner')

    for (const role of ['manager', 'rep'] as const) {
      expect(
        (await h.send('DELETE', `/v1/playbook/calls/${call.id}`, { as: h.people[role] })).status
      ).toBe(403)
      expect(
        (await h.send('POST', `/v1/playbook/calls/${call.id}/restore`, { as: h.people[role] }))
          .status
      ).toBe(403)
    }
    expect((await h.send('DELETE', `/v1/playbook/calls/${call.id}`, { as: stranger })).status).toBe(
      404
    )
    expect(
      (await h.send('POST', `/v1/playbook/calls/${call.id}/restore`, { as: stranger })).status
    ).toBe(404)
    expect((await h.readCall(call.id)).state).toBe('ready')
  })

  test('a lost message is recovered by the cleanup sweep', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h, 'a')
    h.deps.queue.publish = async () => {
      throw new Error('queue down')
    }

    expect((await h.send('DELETE', `/v1/playbook/calls/${call.id}`)).status).toBe(200)
    await h.deps.time.advance(10 * 60_000)
    await cleanupPendingCalls(h.deps, h.organizationId, abort())

    expect(await vectorsOf(h, call.id)).toEqual([])
  })
})
