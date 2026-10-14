import { describe, expect, test } from 'bun:test'
import { callSchema } from 'tula-closeline-contract'
import { ingestionHandlers } from '~/modules/ingestion/handlers'
import { type CallHarness, createCallHarness, transcriptText } from './test-support'

const signal = new AbortController().signal

async function readyCall(h: CallHarness) {
  const response = await h.uploadCall(transcriptText('h', 2), { dealId: 'DEAL-1' })
  const call = callSchema.parse(await response.json())
  await h.runCalls()
  return call
}

const vectorCount = async (h: CallHarness, callId: string) =>
  (
    await h.deps.vectors.search(h.organizationId, {
      vector: new Array<number>(h.deps.vectors.dimensions).fill(0.1),
      topK: 100,
      filter: { call_id: callId },
    })
  ).length

describe('the Call message handlers', () => {
  test('the Rep-changed message only nudges; the rebuild is found by discovery', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h)
    await h.send('PUT', `/v1/playbook/calls/${call.id}/rep`, {
      body: { rep: { by: 'speaker', label: 'Sam' } },
    })
    const message = h.published.at(-1)
    expect(message?.type).toBe('playbook.call_rep_changed')
    const nudged: string[] = []
    const handlers = ingestionHandlers(h.deps, (organizationId) => nudged.push(organizationId))

    await handlers['playbook.call_rep_changed']?.(
      message as never,
      { organizationId: h.organizationId, signal } as never
    )

    expect(nudged).toEqual([h.organizationId])
    expect((await h.readCall(call.id)).state).toBe('processing')
    await h.deps.workers.ingestion.runPass()
    expect((await h.readCall(call.id)).state).toBe('ready')
  })

  test('the Call-deleted message removes the vectors once the job lease has passed, and is a no-op for another Organization', async () => {
    const h = await createCallHarness()
    const call = await readyCall(h)
    await h.send('DELETE', `/v1/playbook/calls/${call.id}`)
    const message = h.published.at(-1)
    expect(message?.type).toBe('playbook.call_deleted')
    const handlers = ingestionHandlers(h.deps, () => undefined)
    expect(await vectorCount(h, call.id)).toBeGreaterThan(0)

    await handlers['playbook.call_deleted']?.(
      message as never,
      { organizationId: `org_${'9'.repeat(32)}`, signal } as never
    )
    expect(await vectorCount(h, call.id)).toBeGreaterThan(0)

    await handlers['playbook.call_deleted']?.(
      message as never,
      { organizationId: h.organizationId, signal } as never
    )
    expect(await vectorCount(h, call.id)).toBe(0)
  })
})
