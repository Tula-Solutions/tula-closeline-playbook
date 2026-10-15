import { describe, expect, spyOn, test } from 'bun:test'
import {
  CURRENT_RIGHTS_WORDING_VERSION,
  callSchema,
  DEFAULT_MAX_CALLS,
} from 'tula-closeline-contract'
import { errorCode, personIn } from '~/modules/document/test-support'
import { CALLS, createCallHarness, transcriptText } from './test-support'

describe('Call upload', () => {
  test('an Owner uploads a Transcript and gets an uploaded Call back (201)', async () => {
    const h = await createCallHarness()
    const response = await h.uploadCall(transcriptText())
    expect(response.status).toBe(201)
    const call = callSchema.parse(await response.json())
    expect(call).toMatchObject({ state: 'uploaded', kind: 'transcript', mediaType: 'text/plain' })
    expect(call.rep).toEqual({ by: 'speaker', label: 'Alex' })
    expect((await h.objectKeys()).length).toBe(1)
    expect(h.deps.database.callJobs(h.organizationId)).toHaveLength(1)
  })

  test('Manager and Rep are refused before the body is read; Admin is allowed', async () => {
    const h = await createCallHarness()
    for (const role of ['manager', 'rep'] as const) {
      const response = await h.uploadCall(transcriptText(), { as: h.people[role] })
      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('auth.forbidden')
    }
    expect((await h.uploadCall(transcriptText(), { as: h.people.admin })).status).toBe(201)
  })

  test('without rights confirmed the answer carries the wording version and stores no Call', async () => {
    const h = await createCallHarness()
    h.deps.database.seedRights({
      organization_id: h.organizationId,
      confirmed_by: h.people.owner.userId,
      confirmed_at: 0,
      wording_version: CURRENT_RIGHTS_WORDING_VERSION + 1,
    })
    const response = await h.uploadCall(transcriptText())
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string; details?: unknown } }
    expect(body.error.code).toBe('rights.confirmation_required')
    expect(body.error.details).toEqual({ wordingVersion: CURRENT_RIGHTS_WORDING_VERSION })
    expect(h.deps.database.calls(h.organizationId)).toHaveLength(0)
    expect(await h.objectKeys()).toHaveLength(0)
  })

  test('the same file again is the stored Call (200) and stores nothing more', async () => {
    const h = await createCallHarness()
    const first = callSchema.parse(await (await h.uploadCall(transcriptText())).json())
    const again = await h.uploadCall(transcriptText())
    expect(again.status).toBe(200)
    expect(callSchema.parse(await again.json()).id).toBe(first.id)
    expect(await h.objectKeys()).toHaveLength(1)
    expect(h.deps.database.callJobs(h.organizationId)).toHaveLength(1)
  })

  test('the same content under another deal is call.content_in_other_deal and names nothing else', async () => {
    const h = await createCallHarness()
    const first = callSchema.parse(
      await (await h.uploadCall(transcriptText(), { dealId: 'DEAL-A' })).json()
    )
    const response = await h.uploadCall(transcriptText(), { dealId: 'DEAL-B' })
    expect(response.status).toBe(409)
    const text = await response.text()
    expect(JSON.parse(text).error.code).toBe('call.content_in_other_deal')
    expect(text).not.toContain(first.id)
    expect(text).not.toContain('DEAL-A')
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test('an idempotency key replays the first answer and a different file under it is refused', async () => {
    const h = await createCallHarness()
    const first = await h.uploadCall(transcriptText('a'), {
      key: '0b9d3b5e-6f0e-4c63-9a53-5a7a1d9d1111',
    })
    const replay = await h.uploadCall(transcriptText('a'), {
      key: '0b9d3b5e-6f0e-4c63-9a53-5a7a1d9d1111',
    })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(await first.json())
    const other = await h.uploadCall(transcriptText('b'), {
      key: '0b9d3b5e-6f0e-4c63-9a53-5a7a1d9d1111',
    })
    expect(other.status).toBe(422)
    expect(await errorCode(other)).toBe('request.idempotency_key_reused')
  })

  test('a bad Rep is call.rep_invalid', async () => {
    const h = await createCallHarness()
    const noRep = await h.uploadCall(transcriptText(), { rep: null })
    expect(noRep.status).toBe(422)
    expect(await errorCode(noRep)).toBe('call.rep_invalid')
    const channel = await h.uploadCall(transcriptText(), {
      rep: JSON.stringify({ by: 'channel', channel: 'left' }),
    })
    expect(await errorCode(channel)).toBe('call.rep_invalid')
  })

  test('an unknown form field, a missing deal id and an empty file are request.invalid', async () => {
    const h = await createCallHarness()
    const extra = await h.uploadCall(transcriptText(), { extra: { other: 'x' } })
    expect(extra.status).toBe(400)
    const noDeal = await h.uploadCall(transcriptText(), { dealId: null })
    expect(noDeal.status).toBe(400)
    const empty = await h.uploadCall('', {})
    expect(await errorCode(empty)).toBe('request.invalid')
  })

  test('a binary file named .txt is call.unsupported_type and leaves no object', async () => {
    const h = await createCallHarness()
    const response = await h.uploadCall(new Uint8Array([0x66, 0x00, 0x67]))
    expect(await errorCode(response)).toBe('call.unsupported_type')
    expect(await h.objectKeys()).toHaveLength(0)
  })

  test('a Transcript over 5 MB is call.too_large', async () => {
    const h = await createCallHarness()
    const big = new Uint8Array(5 * 1024 * 1024 + 1).fill(97)
    const response = await h.uploadCall(big)
    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('call.too_large')
  })

  test('a Transcript far over 5 MB is call.too_large too: it is cut off at its own limit, not held', async () => {
    const h = await createCallHarness()
    const huge = new Uint8Array(5 * 1024 * 1024 + 200_000).fill(97)
    const response = await h.uploadCall(huge)
    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('call.too_large')
    expect(await h.objectKeys()).toHaveLength(0)
  })

  test('no token is refused', async () => {
    const h = await createCallHarness()
    expect((await h.uploadCall(transcriptText(), { as: null })).status).toBe(401)
  })
})

describe('Call upload against stored Calls', () => {
  test('an Organization at its Call limit gets call.quota_exceeded and no new object stays', async () => {
    const h = await createCallHarness()
    h.deps.database.seedDeal({
      id: `deal_${'a'.repeat(32)}`,
      organization_id: h.organizationId,
      deal_id: 'SEED',
    })
    for (let i = 0; i < DEFAULT_MAX_CALLS; i++) {
      h.deps.database.seedCall({
        id: `call_${i.toString(16).padStart(32, '0')}`,
        organization_id: h.organizationId,
        deal_record_id: `deal_${'a'.repeat(32)}`,
      })
    }
    const response = await h.uploadCall(transcriptText())
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('call.quota_exceeded')
    expect(await h.objectKeys()).toHaveLength(0)
  })

  test('a refused upload (quota) never writes its object', async () => {
    const h = await createCallHarness()
    h.deps.database.seedDeal({
      id: `deal_${'a'.repeat(32)}`,
      organization_id: h.organizationId,
      deal_id: 'SEED',
    })
    for (let i = 0; i < DEFAULT_MAX_CALLS; i++) {
      h.deps.database.seedCall({
        id: `call_${i.toString(16).padStart(32, '0')}`,
        organization_id: h.organizationId,
        deal_record_id: `deal_${'a'.repeat(32)}`,
      })
    }
    const put = spyOn(h.deps.objects, 'put')
    const remove = spyOn(h.deps.objects, 'delete')
    const response = await h.uploadCall(transcriptText())
    expect(await errorCode(response)).toBe('call.quota_exceeded')
    expect(put).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  test('a refused upload (rights) never writes its object', async () => {
    const h = await createCallHarness()
    h.deps.database.seedRights({
      organization_id: h.organizationId,
      confirmed_by: h.people.owner.userId,
      confirmed_at: 0,
      wording_version: CURRENT_RIGHTS_WORDING_VERSION + 1,
    })
    const put = spyOn(h.deps.objects, 'put')
    const response = await h.uploadCall(transcriptText())
    expect(await errorCode(response)).toBe('rights.confirmation_required')
    expect(put).not.toHaveBeenCalled()
  })

  test('the same file again at the Call limit is still the stored Call (200), with no second write', async () => {
    const h = await createCallHarness()
    const first = callSchema.parse(await (await h.uploadCall(transcriptText())).json())
    h.deps.database.seedDeal({
      id: `deal_${'b'.repeat(32)}`,
      organization_id: h.organizationId,
      deal_id: 'SEED',
    })
    for (let i = 0; i < DEFAULT_MAX_CALLS; i++) {
      h.deps.database.seedCall({
        id: `call_${i.toString(16).padStart(32, '0')}`,
        organization_id: h.organizationId,
        deal_record_id: `deal_${'b'.repeat(32)}`,
      })
    }
    const put = spyOn(h.deps.objects, 'put')
    const again = await h.uploadCall(transcriptText())
    expect(again.status).toBe(200)
    expect(callSchema.parse(await again.json()).id).toBe(first.id)
    expect(put).not.toHaveBeenCalled()
  })

  test('the same file again restores a deleted Call and queues it', async () => {
    const h = await createCallHarness()
    const first = callSchema.parse(await (await h.uploadCall(transcriptText())).json())
    await h.runCalls()
    const row = h.deps.database.calls(h.organizationId)[0]
    if (row === undefined) {
      throw new Error('no Call')
    }
    row.state = 'deleted'
    row.deleted_at = Date.now()
    row.deletion_seq += 1
    row.epoch += 1
    row.purge_due_at = Date.now() + 86_400_000

    const again = await h.uploadCall(transcriptText())

    expect(again.status).toBe(200)
    const restored = callSchema.parse(await again.json())
    expect(restored.id).toBe(first.id)
    expect(restored.state).not.toBe('deleted')
    await h.runCalls()
    expect((await h.readCall(first.id)).state).toBe('ready')
  })

  test('the same file again re-queues a Call that failed with processing_failed', async () => {
    const h = await createCallHarness()
    const first = callSchema.parse(await (await h.uploadCall(transcriptText())).json())
    await h.runCalls()
    const row = h.deps.database.calls(h.organizationId)[0]
    if (row === undefined) {
      throw new Error('no Call')
    }
    row.state = 'failed'
    row.failure_reason = 'processing_failed'

    const again = await h.uploadCall(transcriptText())

    expect(again.status).toBe(200)
    expect(callSchema.parse(await again.json()).state).not.toBe('failed')
    await h.runCalls()
    expect((await h.readCall(first.id)).state).toBe('ready')
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test('the same file again re-queues a Call that failed for a transient reason, not one the file caused', async () => {
    const h = await createCallHarness()
    const first = callSchema.parse(await (await h.uploadCall('Alex: hi\nAlex: again\n')).json())
    await h.runCalls()
    expect((await h.readCall(first.id)).failureReason).toBe('too_few_speakers')
    const jobs = h.deps.database.callJobs(h.organizationId).length

    const again = await h.uploadCall('Alex: hi\nAlex: again\n')

    expect(again.status).toBe(200)
    expect(callSchema.parse(await again.json()).state).toBe('failed')
    expect(h.deps.database.callJobs(h.organizationId)).toHaveLength(jobs)
  })
})

describe('Call list and read', () => {
  test('lists newest first with filters and a cursor, and reads one', async () => {
    const h = await createCallHarness()
    const ids: string[] = []
    for (const seed of ['a', 'b', 'c']) {
      const call = callSchema.parse(await (await h.uploadCall(transcriptText(seed))).json())
      ids.push(call.id)
    }
    const page = (await (await h.send('GET', `${CALLS}?limit=2`)).json()) as {
      items: { id: string }[]
      nextCursor: string | null
    }
    expect(page.items.map((i) => i.id)).toEqual([ids[2] as string, ids[1] as string])
    expect(page.nextCursor).not.toBeNull()
    expect((await h.listAll()).map((c) => String(c.id))).toEqual([
      ids[2] as string,
      ids[1] as string,
      ids[0] as string,
    ])
    expect(await h.listAll('state=ready')).toHaveLength(0)
    expect(await h.listAll('state=uploaded')).toHaveLength(3)
    const call = await h.readCall(ids[0] as string)
    expect(String(call.id)).toBe(ids[0] as string)
  })

  test('a bad cursor is request.invalid', async () => {
    const h = await createCallHarness()
    const response = await h.send('GET', `${CALLS}?cursor=not-a-cursor`)
    expect(response.status).toBe(400)
  })

  test('Manager and Rep cannot list or read; a second Organization sees nothing', async () => {
    const h = await createCallHarness()
    const call = callSchema.parse(await (await h.uploadCall(transcriptText())).json())
    for (const role of ['manager', 'rep'] as const) {
      expect((await h.send('GET', CALLS, { as: h.people[role] })).status).toBe(403)
      expect((await h.send('GET', `${CALLS}/${call.id}`, { as: h.people[role] })).status).toBe(403)
    }
    const stranger = personIn(`org_${'9'.repeat(32)}`, 'owner')
    const read = await h.send('GET', `${CALLS}/${call.id}`, { as: stranger })
    expect(read.status).toBe(404)
    expect(await errorCode(read)).toBe('call.not_found')
    const listed = (await (await h.send('GET', CALLS, { as: stranger })).json()) as {
      items: unknown[]
    }
    expect(listed.items).toHaveLength(0)
  })
})
