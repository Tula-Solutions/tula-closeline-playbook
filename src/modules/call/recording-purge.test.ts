import { describe, expect, spyOn, test } from 'bun:test'
import { type Call, callSchema } from 'tula-closeline-contract'
import { INTERNAL_CALL_USER_ID } from 'tula-closeline-db/schema'
import { eraseCalls } from './erase'
import { purgeCalls } from './purge'
import { type CallHarness, channelRep, createCallHarness } from './test-support'

const abort = () => new AbortController().signal

async function transcribedRecording(
  h: CallHarness,
  seed: string,
  options: Parameters<CallHarness['uploadRecording']>[1] = {}
): Promise<Call> {
  const response = await h.uploadRecording(seed, options)
  expect(response.status).toBe(201)
  const call = callSchema.parse(await response.json())
  await h.runCalls()
  return call
}

/** Marks a Call deleted and due for purge, as the delete route does once its retention has passed. */
function deleteNow(h: CallHarness, id: string): void {
  const row = h.deps.database.calls(h.organizationId).find((c) => c.id === id)
  if (row === undefined) {
    throw new Error('no such Call')
  }
  const now = h.deps.clock.now().getTime()
  row.state = 'deleted'
  row.deleted_at = now
  row.deletion_seq += 1
  row.epoch += 1
  row.purge_due_at = now
}

const rowOf = (h: CallHarness, id: string) =>
  h.deps.database.calls(h.organizationId).find((c) => c.id === id)

describe('purging a Recording Call', () => {
  test('deletes the vendor copy, the audio and the Transcript, confirms, and removes the row', async () => {
    const h = await createCallHarness()
    const call = await transcribedRecording(h, 'purge')
    expect(h.deps.transcriber.copies(h.organizationId)).toHaveLength(1)
    deleteNow(h, call.id)
    const events: string[] = []
    const realDelete = h.deps.transcriber.delete.bind(h.deps.transcriber)
    spyOn(h.deps.transcriber, 'delete').mockImplementation(async (...args) => {
      events.push('vendor')
      return realDelete(...args)
    })
    const realObjectDelete = h.deps.objects.delete.bind(h.deps.objects)
    spyOn(h.deps.objects, 'delete').mockImplementation(async (org, key) => {
      events.push(`object:${key.endsWith('original.wav') ? 'audio' : 'other'}`)
      return realObjectDelete(org, key)
    })

    const result = await purgeCalls(h.deps, h.organizationId, abort())

    expect(result).toEqual({ purged: 1, deferred: 0 })
    expect(h.deps.transcriber.copies(h.organizationId)).toEqual([])
    expect(await h.objectKeys()).toEqual([])
    expect(rowOf(h, call.id)).toBeUndefined()
    expect(h.deps.database.vendorSends(h.organizationId)).toEqual([])
    // The vendor's copy goes before the stored audio.
    expect(events.indexOf('vendor')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('vendor')).toBeLessThan(events.indexOf('object:audio'))
  })

  test('a vendor that cannot delete leaves the Call, the audio and the confirmation alone, and the retry finishes it', async () => {
    const h = await createCallHarness()
    const call = await transcribedRecording(h, 'retry')
    deleteNow(h, call.id)
    h.deps.transcriber.failNext('delete', 'transcriber.unavailable', 3)

    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await purgeCalls(h.deps, h.organizationId, abort())
      expect(result).toEqual({ purged: 0, deferred: 1 })
      // Never confirmed early, and the audio is kept until the vendor copy is gone.
      expect(rowOf(h, call.id)?.vendor_removed_at).toBeNull()
      expect(await h.objectKeys()).toContain(`calls/${call.id}/original.wav`)
      expect(h.deps.transcriber.copies(h.organizationId)).toHaveLength(1)
      await h.deps.time.advance(h.deps.env.PURGE_LEASE_MS + 1000)
    }
    const result = await purgeCalls(h.deps, h.organizationId, abort())

    expect(result).toEqual({ purged: 1, deferred: 0 })
    expect(h.deps.transcriber.copies(h.organizationId)).toEqual([])
    expect(await h.objectKeys()).toEqual([])
    const lines = h.deps.logLines.join('\n')
    expect(lines).not.toContain('mem_')
    expect(lines).not.toContain(call.id.replace('call_', 'zz'))
  })

  test('a failure while listing the vendor also leaves the Call for the retry', async () => {
    const h = await createCallHarness()
    const call = await transcribedRecording(h, 'list-fails')
    deleteNow(h, call.id)
    h.deps.transcriber.failNext('list', 'transcriber.unavailable')

    expect(await purgeCalls(h.deps, h.organizationId, abort())).toEqual({ purged: 0, deferred: 1 })
    expect(rowOf(h, call.id)).toBeDefined()
    await h.deps.time.advance(h.deps.env.PURGE_LEASE_MS + 1000)
    expect(await purgeCalls(h.deps, h.organizationId, abort())).toEqual({ purged: 1, deferred: 0 })
  })

  test('every counted send is deleted, also one whose id was never stored and one the vendor never got', async () => {
    const h = await createCallHarness()
    const call = await uploadAndFailOnce(h)
    // Send 1 never reached the vendor; send 2 did.
    expect(h.deps.database.vendorSends(h.organizationId).map((s) => s.seq)).toEqual([1, 2])
    // The id of send 2 is forgotten, as if the worker died before storing it.
    for (const send of h.deps.database.vendorSends(h.organizationId)) {
      send.vendor_id = null
    }
    deleteNow(h, call.id)

    expect(await purgeCalls(h.deps, h.organizationId, abort())).toEqual({ purged: 1, deferred: 0 })
    expect(h.deps.transcriber.copies(h.organizationId)).toEqual([])
  })

  test('a worker killed after the vendor accepted a send and before the id was stored leaves no copy after the purge', async () => {
    const h = await createCallHarness()
    const response = await h.uploadRecording('killed')
    const call = callSchema.parse(await response.json())
    h.deps.transcriber.acceptThenFailNext()
    await h.runCalls()
    expect(h.deps.transcriber.copies(h.organizationId)).toHaveLength(1)
    expect(h.deps.database.vendorSends(h.organizationId)[0]?.vendor_id).toBeNull()
    // The Call is deleted before the retry: the purge must find the copy by its reference.
    const deleted = await h.send('DELETE', `/v1/playbook/calls/${call.id}`)
    expect(deleted.status).toBe(200)
    const row = rowOf(h, call.id)
    if (row !== undefined) {
      row.purge_due_at = h.deps.clock.now().getTime()
    }
    await h.deps.time.advance(h.deps.env.INGESTION_LEASE_MS + 1000)

    expect(await purgeCalls(h.deps, h.organizationId, abort())).toEqual({ purged: 1, deferred: 0 })
    expect(h.deps.transcriber.copies(h.organizationId)).toEqual([])
  })

  test('a Recording never sent needs no vendor confirmation', async () => {
    const h = await createCallHarness()
    const response = await h.uploadRecording('unsent')
    const call = callSchema.parse(await response.json())
    deleteNow(h, call.id)
    const deleteSpy = spyOn(h.deps.transcriber, 'delete')

    expect(await purgeCalls(h.deps, h.organizationId, abort())).toEqual({ purged: 1, deferred: 0 })
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  test('the confirmation waits for a job that still holds its lease', async () => {
    const h = await createCallHarness()
    const call = await transcribedRecording(h, 'lease')
    const row = rowOf(h, call.id)
    deleteNow(h, call.id)
    // A cancelled job whose lease has not ended: the database refuses the confirmation and the purge.
    const job = h.deps.database.callJobs(h.organizationId).at(-1)
    if (job !== undefined) {
      job.state = 'cancelled'
      job.next_attempt_at = h.deps.clock.now().getTime() + 60_000
    }

    const result = await purgeCalls(h.deps, h.organizationId, abort())

    expect(result.purged).toBe(0)
    expect(row?.vendor_removed_at).toBeNull()
  })

  test("one Organization's purge leaves another Organization's vendor copy alone", async () => {
    const h = await createCallHarness()
    const mine = await transcribedRecording(h, 'mine', { dealId: 'D-1' })
    const otherId = `org_${'4'.repeat(32)}`
    await h.deps.transcriber.submit(otherId, {
      clientReference: `${mine.id}:1`,
      audio: { url: 'http://memory.object-store.invalid/x' },
      audioKey: 'calls/other:1',
      speakers: 'diarize',
    })
    deleteNow(h, mine.id)

    await purgeCalls(h.deps, h.organizationId, abort())

    expect(h.deps.transcriber.copies(h.organizationId)).toEqual([])
    expect(h.deps.transcriber.copies(otherId)).toHaveLength(1)
  })
})

/** A Recording whose first send failed before the vendor got it and whose second was transcribed. */
async function uploadAndFailOnce(h: CallHarness): Promise<Call> {
  const response = await h.uploadRecording('twice')
  const call = callSchema.parse(await response.json())
  h.deps.transcriber.failNext('submit', 'transcriber.unavailable')
  await h.runCalls()
  await h.deps.time.advance(20 * 60 * 1000)
  await h.runCalls()
  return call
}

describe('erasing Recording Calls', () => {
  test('remove-all deletes the vendor copy and the audio before the Call is gone', async () => {
    const h = await createCallHarness()
    const stereo = await transcribedRecording(h, 'erase-a', {
      rep: channelRep('right'),
      dealId: 'D-1',
    })
    await transcribedRecording(h, 'erase-b', { dealId: 'D-2' })
    expect(h.deps.transcriber.copies(h.organizationId)).toHaveLength(2)

    const purged = await eraseCalls(h.deps, h.organizationId, INTERNAL_CALL_USER_ID)

    expect(purged).toBe(2)
    expect(h.deps.transcriber.copies(h.organizationId)).toEqual([])
    expect(await h.objectKeys()).toEqual([])
    expect(h.deps.database.calls(h.organizationId)).toEqual([])
    expect(rowOf(h, stereo.id)).toBeUndefined()
  })

  test('an erase that cannot reach the vendor leaves the Call, so the remove-all repeats', async () => {
    const h = await createCallHarness()
    const call = await transcribedRecording(h, 'erase-fail')
    h.deps.transcriber.failNext('delete', 'transcriber.unavailable', 5)

    const purged = await eraseCalls(h.deps, h.organizationId, INTERNAL_CALL_USER_ID)

    expect(purged).toBe(0)
    expect(rowOf(h, call.id)).toBeDefined()
    expect(rowOf(h, call.id)?.vendor_removed_at).toBeNull()
  })
})
