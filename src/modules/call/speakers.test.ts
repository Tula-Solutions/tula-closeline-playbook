import { describe, expect, test } from 'bun:test'
import {
  callSchema,
  listCallsResponseSchema,
  MAX_TRANSCRIPT_BYTES,
  speakerExcerpt,
} from 'tula-closeline-contract'
import { errorCode, personIn } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'
import { CALLS, type CallHarness, createCallHarness, transcriptText } from './test-support'

const SECRET = 'swordfish-7731'

/** A mono Recording that has been transcribed and waits for a Rep. */
async function awaitingRep(h: CallHarness) {
  const response = await h.uploadRecording('mono')
  expect(response.status).toBe(201)
  const call = callSchema.parse(await response.json())
  await h.runCalls()
  expect((await h.readCall(call.id)).state).toBe('awaiting_rep')
  return call
}

/** The excerpts the kept Transcript should give, worked out from the stored turns. */
async function expectedExcerpts(h: CallHarness, callId: string) {
  const stored = await h.deps.objects.get(h.organizationId, `calls/${callId}/transcript.json`)
  const turns = JSON.parse(new TextDecoder().decode(stored?.body)) as {
    speaker: string
    text: string
  }[]
  const labels = [...new Set(turns.map((t) => t.speaker))]
  return labels.map((label) => ({
    label,
    excerpt: speakerExcerpt(turns.filter((t) => t.speaker === label).map((t) => t.text)),
  }))
}

describe('the speakers of a Recording', () => {
  test('a mono Recording in awaiting_rep returns one excerpt per speaker, built from the kept Transcript', async () => {
    const h = await createCallHarness()
    const call = await awaitingRep(h)

    const read = await h.readCall(call.id)

    expect(read.speakers).toHaveLength(2)
    expect(read.speakers?.map((s) => s.label)).toEqual(['A', 'B'])
    expect(read.speakers).toEqual(await expectedExcerpts(h, call.id))
    expect(read.speakers?.every((s) => s.excerpt.length > 0)).toBe(true)
  })

  test('only the Call read carries them: the list has none', async () => {
    const h = await createCallHarness()
    await awaitingRep(h)

    const listed = listCallsResponseSchema.parse(await (await h.send('GET', CALLS)).json())

    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]).not.toHaveProperty('speakers')
    expect(JSON.stringify(listed)).not.toContain('"speakers"')
  })

  test('a second Organization gets a 404, and a Rep or Manager a 403, never the text', async () => {
    const h = await createCallHarness()
    const call = await awaitingRep(h)
    h.confirmRights()

    const stranger = await h.send('GET', `${CALLS}/${call.id}`, {
      as: personIn(newOrganizationId(), 'owner'),
    })
    const rep = await h.send('GET', `${CALLS}/${call.id}`, { as: h.people.rep })

    expect(stranger.status).toBe(404)
    expect(await errorCode(stranger)).toBe('call.not_found')
    expect(rep.status).toBe(403)
    expect(await h.send('GET', `${CALLS}/${call.id}`, { as: h.people.admin })).toMatchObject({
      status: 200,
    })
  })

  test('a Transcript upload has no speakers field', async () => {
    const h = await createCallHarness()
    const response = await h.uploadCall(transcriptText('x'), { dealId: 'D-1' })
    const call = callSchema.parse(await response.json())
    await h.runCalls()

    expect((await h.readCall(call.id)).speakers).toBeUndefined()
  })

  test('a Transcript missing from the store leaves speakers out, and the read is still 200', async () => {
    const h = await createCallHarness()
    const call = await awaitingRep(h)
    await h.deps.objects.delete(h.organizationId, `calls/${call.id}/transcript.json`)

    const response = await h.send('GET', `${CALLS}/${call.id}`)

    expect(response.status).toBe(200)
    const read = callSchema.parse(await response.json())
    expect(read.speakers).toBeUndefined()
    expect(read.speakerLabels).toEqual(['A', 'B'])
  })

  test('a store that fails or returns garbage leaves speakers out, and no text is logged', async () => {
    const h = await createCallHarness()
    const call = await awaitingRep(h)
    const original = h.deps.objects.get.bind(h.deps.objects)
    h.deps.objects.get = async () => {
      throw new Error(`store down ${SECRET}`)
    }
    expect((await h.send('GET', `${CALLS}/${call.id}`)).status).toBe(200)
    expect(
      callSchema.parse(await (await h.send('GET', `${CALLS}/${call.id}`)).json()).speakers
    ).toBeUndefined()

    h.deps.objects.get = async (organizationId, key) => {
      const stored = await original(organizationId, key)
      return stored === undefined
        ? stored
        : { ...stored, body: new TextEncoder().encode('not json') }
    }
    expect(
      callSchema.parse(await (await h.send('GET', `${CALLS}/${call.id}`)).json()).speakers
    ).toBeUndefined()
    expect(h.deps.logLines.join('\n')).not.toContain(SECRET)
  })

  test('a Transcript the store reports over the cap is never read: head only, get and getStream untouched', async () => {
    const h = await createCallHarness()
    const call = await awaitingRep(h)
    const head = h.deps.objects.head.bind(h.deps.objects)
    h.deps.objects.head = async (organizationId, key) => {
      const info = await head(organizationId, key)
      return info === undefined ? info : { ...info, size: 6 * 1024 * 1024 }
    }
    let reads = 0
    h.deps.objects.get = async () => {
      reads++
      throw new Error('get must not be called')
    }
    h.deps.objects.getStream = async () => {
      reads++
      throw new Error('getStream must not be called')
    }

    const response = await h.send('GET', `${CALLS}/${call.id}`)

    expect(response.status).toBe(200)
    expect(callSchema.parse(await response.json()).speakers).toBeUndefined()
    expect(reads).toBe(0)
  })

  test('a ready Recording, whose Rep can still be changed, returns the excerpts too', async () => {
    const h = await createCallHarness()
    const call = await awaitingRep(h)
    const picked = await h.send('PUT', `${CALLS}/${call.id}/rep`, {
      body: { rep: { by: 'speaker', label: 'A' } },
    })
    expect(picked.status).toBe(200)
    await h.runCalls()
    expect((await h.readCall(call.id)).state).toBe('ready')

    const read = await h.readCall(call.id)

    expect(read.speakers).toEqual(await expectedExcerpts(h, call.id))
  })

  test('a Recording in a state where the Rep cannot be changed does no object read and has no speakers', async () => {
    const h = await createCallHarness()
    const call = await awaitingRep(h)
    const row = h.deps.database.calls(h.organizationId).find((c) => c.id === call.id)
    if (row === undefined) {
      throw new Error('no Call')
    }
    row.state = 'failed'
    row.failure_reason = 'transcription_failed'
    const touched: string[] = []
    for (const name of ['get', 'head', 'getStream'] as const) {
      h.deps.objects[name] = (async () => {
        touched.push(name)
        throw new Error(`${name} must not be called`)
      }) as never
    }

    const response = await h.send('GET', `${CALLS}/${call.id}`)

    expect(response.status).toBe(200)
    const read = callSchema.parse(await response.json())
    expect(read).toMatchObject({ state: 'failed', speakerLabels: ['A', 'B'] })
    expect(read.speakers).toBeUndefined()
    expect(touched).toEqual([])
  })

  test('a stored Transcript over the byte cap is not parsed: speakers are left out and the read is 200', async () => {
    const h = await createCallHarness()
    const call = await awaitingRep(h)
    const valid = JSON.stringify([
      { speaker: 'A', text: 'hello there' },
      { speaker: 'B', text: 'hi' },
    ])
    const huge = new TextEncoder().encode(valid.padEnd(MAX_TRANSCRIPT_BYTES + 1, ' '))
    await h.deps.objects.put(h.organizationId, `calls/${call.id}/transcript.json`, huge)

    const response = await h.send('GET', `${CALLS}/${call.id}`)

    expect(response.status).toBe(200)
    expect(callSchema.parse(await response.json()).speakers).toBeUndefined()
  })

  test('a store that never answers is cut off by the timeout, and the read still answers 200 without speakers', async () => {
    const h = await createCallHarness({ env: { INGESTION_IO_TIMEOUT_MS: '1000' } })
    const call = await awaitingRep(h)
    h.deps.objects.get = () => new Promise(() => undefined)

    const started = Date.now()
    const response = await h.send('GET', `${CALLS}/${call.id}`)

    expect(response.status).toBe(200)
    expect(callSchema.parse(await response.json()).speakers).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
