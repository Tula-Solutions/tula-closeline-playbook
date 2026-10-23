import { describe, expect, test } from 'bun:test'
import { callSchema } from 'tula-closeline-contract'
import { registry } from '~/messages'
import { createCallHarness, transcriptText } from '~/modules/call/test-support'
import { ingestionHandlers } from './handlers'

const signal = new AbortController().signal
const prospectId = `prs_${'a'.repeat(32)}`

describe('the prospect.erased handler', () => {
  test('the registry accepts the message core publishes', () => {
    const envelope = registry.create({
      type: 'prospect.erased',
      organizationId: `org_${'1'.repeat(32)}`,
      payload: { prospectId },
      traceId: 'trace',
    })
    const decoded = registry.decode(registry.encode(envelope))
    expect(decoded.ok).toBe(true)
  })

  test('a redelivery or an unknown Prospect succeeds and every Organization keeps its Calls and vectors', async () => {
    const h = await createCallHarness()
    const response = await h.uploadCall(transcriptText('p', 2), { dealId: 'DEAL-1' })
    const call = callSchema.parse(await response.json())
    await h.runCalls()
    const count = async () =>
      (
        await h.deps.vectors.search(h.organizationId, {
          vector: new Array<number>(h.deps.vectors.dimensions).fill(0.1),
          topK: 100,
          filter: { call_id: call.id },
        })
      ).length
    const before = await count()
    expect(before).toBeGreaterThan(0)
    const handlers = ingestionHandlers(h.deps, () => undefined)
    const message = registry.create({
      type: 'prospect.erased',
      organizationId: `org_${'9'.repeat(32)}`,
      payload: { prospectId },
      traceId: 'trace',
    })

    for (const organizationId of [`org_${'9'.repeat(32)}`, h.organizationId, h.organizationId]) {
      await handlers['prospect.erased']?.(message as never, { organizationId, signal } as never)
    }

    expect(await count()).toBe(before)
    expect((await h.readCall(call.id)).state).toBe('ready')
  })
})
