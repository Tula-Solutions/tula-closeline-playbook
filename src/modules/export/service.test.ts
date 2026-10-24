import { describe, expect, spyOn, test } from 'bun:test'
import { callSchema } from 'tula-closeline-contract'
import { type ExportReplyEnvelope, registry } from '~/messages'
import {
  type CallHarness,
  createCallHarness,
  transcriptText,
  wavBytes,
} from '~/modules/call/test-support'
import { pdfBytes, personIn } from '~/modules/document/test-support'
import { ingestionHandlers } from '~/modules/ingestion/handlers'
import { newOrganizationId } from '~/testing'
import * as Exports from './service'

const signal = new AbortController().signal
const exportId = `exp_${'a'.repeat(32)}`

type Harness = CallHarness & { sent: ExportReplyEnvelope[] }

async function harness(rowsPerFile = 2): Promise<Harness> {
  const h = await createCallHarness({ env: { EXPORT_ROWS_PER_FILE: String(rowsPerFile) } })
  const sent: ExportReplyEnvelope[] = []
  const original = h.deps.exportQueue.publish.bind(h.deps.exportQueue)
  spyOn(h.deps.exportQueue, 'publish').mockImplementation(async (envelope) => {
    sent.push(envelope)
    await original(envelope)
  })
  return Object.assign(h, { sent })
}

/** Delivers an `export.requested` message for `organizationId` the way the consumer does. */
async function deliver(
  h: Harness,
  options: { organizationId?: string; links?: boolean; receiveCount?: number; id?: string } = {}
) {
  const organizationId = options.organizationId ?? h.organizationId
  const message = registry.create({
    type: 'export.requested',
    organizationId,
    traceId: 'trace',
    payload: {
      exportId: options.id ?? exportId,
      requestedByMembershipId: `mem_${'b'.repeat(32)}`,
      includeRecordingLinks: options.links ?? false,
      requestedAt: new Date(0).toISOString(),
    },
  })
  const handlers = ingestionHandlers(h.deps, () => undefined)
  await handlers['export.requested']?.(
    message as never,
    {
      organizationId,
      traceId: 'trace',
      receiveCount: options.receiveCount ?? 1,
      signal,
    } as never
  )
}

const prefixOf = (id = exportId) => `exports/${id}/playbook`

async function files(h: Harness, organizationId = h.organizationId, id = exportId) {
  const page = await h.deps.objects.list(organizationId, {
    prefix: `${prefixOf(id)}/`,
    limit: 1000,
  })
  return page.items.map((item) => item.key).sort()
}

async function rows(h: Harness, dataset: string, organizationId = h.organizationId) {
  const out: Record<string, unknown>[] = []
  for (const key of await files(h, organizationId)) {
    if (key.startsWith(`${prefixOf()}/${dataset}-`)) {
      const stored = await h.deps.objects.get(organizationId, key)
      const text = new TextDecoder().decode(stored?.body)
      expect(text.endsWith('\n')).toBe(true)
      for (const line of text.trimEnd().split('\n')) {
        out.push(JSON.parse(line) as Record<string, unknown>)
      }
    }
  }
  return out
}

async function seed(h: Harness, tag: string, organizationId = h.organizationId, calls = 3) {
  const owner = personIn(organizationId, 'owner')
  h.confirmRights(organizationId)
  const document = await h.upload(`${tag}.pdf`, pdfBytes(tag), { as: owner })
  expect(document.status).toBe(201)
  const ids: string[] = []
  for (let i = 0; i < calls; i++) {
    const response = await h.uploadCall(transcriptText(`${tag}${i}`, 2), {
      name: `${tag}-${i}.txt`,
      dealId: `DEAL-${tag}-${i}`,
      as: owner,
    })
    ids.push(callSchema.parse(await response.json()).id)
  }
  await h.runCalls()
  return ids
}

describe('the export slice', () => {
  test('writes every dataset under the part prefix, chunked, and reports the totals', async () => {
    const h = await harness(2)
    await seed(h, 'one')
    await deliver(h)

    const keys = await files(h)
    expect(keys.filter((k) => k.includes('/transcripts-'))).toHaveLength(2)
    expect(keys.filter((k) => k.includes('/deals-'))).toHaveLength(2)
    expect(keys.filter((k) => k.includes('/documents-'))).toHaveLength(1)
    expect(keys.some((k) => k.includes('/recordings-'))).toBe(false)
    expect((await rows(h, 'documents'))[0]?.fileName).toBe('one.pdf')
    expect(await rows(h, 'transcripts')).toHaveLength(3)
    expect(await rows(h, 'deals')).toHaveLength(3)
    expect(await rows(h, 'outcomes')).toHaveLength(3)
    expect((await rows(h, 'moments')).length).toBeGreaterThan(0)
    const original = keys.find((k) => k.includes('/documents/') && k.endsWith('/original.pdf'))
    expect(original).toBeDefined()

    const reply = h.sent.at(-1)
    expect(reply?.type).toBe('export.part_ready')
    if (reply?.type === 'export.part_ready') {
      expect(reply.payload.prefix).toBe(prefixOf())
      expect(reply.payload.service).toBe('playbook')
      expect(reply.payload.fileCount).toBe(keys.length)
      expect(reply.payload.bytes).toBeGreaterThan(0)
      expect(reply.organizationId).toBe(h.organizationId)
    }
  })

  test('a transcript row carries the turns and the moments, and no key or hash', async () => {
    const h = await harness(50)
    const [callId] = await seed(h, 'two', h.organizationId, 1)
    await deliver(h)
    const [transcript] = await rows(h, 'transcripts')
    expect(transcript?.id).toBe(callId)
    expect(Array.isArray(transcript?.turns)).toBe(true)
    const everything = JSON.stringify([
      transcript,
      ...(await rows(h, 'documents')),
      ...(await rows(h, 'deals')),
      ...(await rows(h, 'moments')),
    ])
    expect(everything).not.toMatch(/hash|sha256|secret|token|object_key|objectKey|calls\//i)
  })

  test('Recording links are written only when asked for', async () => {
    const h = await harness(50)
    const owner = h.people.owner
    await h.uploadCall(wavBytes('rec'), {
      name: 'call.wav',
      type: 'audio/wav',
      rep: JSON.stringify({ by: 'channel', channel: 'left' }),
      dealId: 'DEAL-R',
      as: owner,
    })
    await h.runCalls()
    await deliver(h, { links: false })
    expect(await rows(h, 'recordings')).toHaveLength(0)

    await deliver(h, { links: true })
    const [recording] = await rows(h, 'recordings')
    expect(recording?.fileName).toBe('call.wav')
    expect(String(recording?.url)).toMatch(/^https?:/)
    expect(typeof recording?.expiresAt).toBe('string')
    // The link is a pointer: the audio is not copied into the export.
    expect((await files(h)).some((k) => k.endsWith('.wav'))).toBe(false)
  })

  test('a redelivery writes the same part once', async () => {
    const h = await harness(2)
    await seed(h, 'three')
    await deliver(h)
    const first = await files(h)
    const firstPayload = h.sent.at(-1)?.payload as { fileCount: number; bytes: number }
    const sizes = await Promise.all(first.map((k) => h.deps.objects.head(h.organizationId, k)))
    await deliver(h)
    expect(await files(h)).toEqual(first)
    const again = await Promise.all(first.map((k) => h.deps.objects.head(h.organizationId, k)))
    expect(again.map((i) => i?.size)).toEqual(sizes.map((i) => i?.size))
    const second = h.sent.at(-1)
    expect(second?.type).toBe('export.part_ready')
    expect(second?.payload).toMatchObject({
      fileCount: firstPayload.fileCount,
      bytes: firstPayload.bytes,
    })
  })

  test('pages of one row give the same rows as one big page', async () => {
    const h = await harness(50)
    await seed(h, 'five', h.organizationId, 3)
    await deliver(h)
    const whole = [await rows(h, 'deals'), await rows(h, 'transcripts'), await rows(h, 'documents')]
    await Exports.writeSlice(h.deps, {
      organizationId: h.organizationId,
      exportId,
      includeRecordingLinks: false,
      traceId: 't',
      receiveCount: 1,
      signal,
      pageSize: 1,
    })
    expect([
      await rows(h, 'deals'),
      await rows(h, 'transcripts'),
      await rows(h, 'documents'),
    ]).toEqual(whole)
  })

  test('stale files of an earlier attempt are removed', async () => {
    const h = await harness(2)
    await h.deps.objects.put(
      h.organizationId,
      `${prefixOf()}/deals-0099.ndjson`,
      new Uint8Array([1])
    )
    await deliver(h)
    expect(await files(h)).not.toContain(`${prefixOf()}/deals-0099.ndjson`)
  })

  test("a second Organization's rows and files are absent", async () => {
    const h = await harness(2)
    const other = newOrganizationId()
    await seed(h, 'mine')
    await seed(h, 'theirs', other)
    await deliver(h)
    const text = JSON.stringify([
      ...(await rows(h, 'documents')),
      ...(await rows(h, 'transcripts')),
      ...(await rows(h, 'deals')),
      ...(await rows(h, 'moments')),
    ])
    expect(text).toContain('mine')
    expect(text).not.toContain('theirs')
    expect(await files(h, other)).toEqual([])
    const reply = h.sent.at(-1)
    expect(reply?.organizationId).toBe(h.organizationId)
  })

  test('an Organization with no data writes an empty part and still reports it', async () => {
    const h = await harness(2)
    await deliver(h)
    expect(h.sent.at(-1)?.type).toBe('export.part_ready')
  })

  test('a failure is retried, and on the last attempt reported with a closed reason', async () => {
    const h = await harness(2)
    await seed(h, 'four')
    spyOn(h.deps.objects, 'put').mockRejectedValue(new Error('boom: secret detail'))
    await expect(deliver(h, { receiveCount: 1 })).rejects.toThrow()
    expect(h.sent).toHaveLength(0)

    await deliver(h, { receiveCount: 3 })
    const reply = h.sent.at(-1)
    expect(reply?.type).toBe('export.part_failed')
    expect(JSON.stringify(reply)).not.toContain('secret detail')
  })

  test('a part over the file cap fails at once, without a retry', async () => {
    const h = await harness(1)
    await seed(h, 'six', h.organizationId, 3)
    await Exports.writeSlice(h.deps, {
      organizationId: h.organizationId,
      exportId,
      includeRecordingLinks: false,
      traceId: 't',
      receiveCount: 1,
      signal,
      maxFiles: 2,
    })
    const reply = h.sent.at(-1)
    expect(reply?.type).toBe('export.part_failed')
    expect(reply?.payload).toMatchObject({ reason: 'write_failed' })
  })

  test('a failed part_ready publish is not reported as a failed slice', async () => {
    const h = await harness(2)
    spyOn(h.deps.exportQueue, 'publish').mockRejectedValue(new Error('queue down'))
    await expect(deliver(h, { receiveCount: 3 })).rejects.toThrow('queue down')
    expect(h.sent).toHaveLength(0)
  })

  test('a message without an Organization does nothing', async () => {
    const h = await harness(2)
    const handlers = ingestionHandlers(h.deps, () => undefined)
    const message = registry.create({
      type: 'export.requested',
      organizationId: h.organizationId,
      traceId: 't',
      payload: {
        exportId,
        requestedByMembershipId: `mem_${'b'.repeat(32)}`,
        includeRecordingLinks: false,
        requestedAt: new Date(0).toISOString(),
      },
    })
    await handlers['export.requested']?.(message as never, { signal, receiveCount: 1 } as never)
    expect(h.sent).toHaveLength(0)
  })
})
