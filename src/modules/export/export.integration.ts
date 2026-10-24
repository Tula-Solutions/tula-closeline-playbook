// Runs the export slice against the compose Postgres (`bun run test:integration`); it is not part of
// `bun test src`. The unit suite runs it on a double of the database; this runs the db library's
// real list statements with their cursors and row-level security. Objects and the queue stay in
// memory.

import { afterAll, describe, expect, test } from 'bun:test'
import { CURRENT_RIGHTS_WORDING_VERSION, callSchema } from 'tula-closeline-contract'
import { createDb, RIGHTS_CONFIRM } from 'tula-closeline-db'
import { scopeOver } from '~/adapters/postgres/processed-store'
import { integrationUrls } from '~/integration-support'
import { type CallHarness, createCallHarness, transcriptText } from '~/modules/call/test-support'
import { pdfBytes } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'
import { writeSlice } from './service'

const urls = integrationUrls()
const service = createDb(urls.service)
afterAll(async () => {
  await service.close()
})

const signal = new AbortController().signal
const exportId = `exp_${'c'.repeat(32)}`
const prefix = `exports/${exportId}/playbook`

async function harness(): Promise<CallHarness> {
  const h = await createCallHarness({
    scope: scopeOver(service.db),
    env: { EXPORT_ROWS_PER_FILE: '2' },
  })
  await h.deps.scope(h.organizationId, (run) =>
    run(RIGHTS_CONFIRM, [h.organizationId, h.people.owner.userId, CURRENT_RIGHTS_WORDING_VERSION])
  )
  return h
}

async function rowsOf(h: CallHarness, organizationId: string, dataset: string) {
  const page = await h.deps.objects.list(organizationId, {
    prefix: `${prefix}/${dataset}-`,
    limit: 1000,
  })
  const out: Record<string, unknown>[] = []
  for (const item of page.items) {
    const stored = await h.deps.objects.get(organizationId, item.key)
    for (const line of new TextDecoder().decode(stored?.body).trimEnd().split('\n')) {
      out.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return out
}

describe('the export slice against Postgres', () => {
  test('pages through real cursors and writes only the requesting Organization', async () => {
    const h = await harness()
    expect((await h.upload('mine.pdf', pdfBytes('mine'))).status).toBe(201)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const response = await h.uploadCall(transcriptText(`mine${i}`, 2), { dealId: `MINE-${i}` })
      expect(response.status).toBe(201)
      ids.push(callSchema.parse(await response.json()).id)
    }
    await h.runCalls()
    // A second Organization with its own rows in the same database.
    const other = newOrganizationId()
    const stranger = (await import('~/modules/document/test-support')).personIn(other, 'owner')
    await h.deps.scope(other, (run) =>
      run(RIGHTS_CONFIRM, [other, stranger.userId, CURRENT_RIGHTS_WORDING_VERSION])
    )
    const theirs = await h.uploadCall(transcriptText('theirs', 2), {
      dealId: 'THEIRS',
      as: stranger,
    })
    expect(theirs.status).toBe(201)
    await h.runCalls()

    await writeSlice(h.deps, {
      organizationId: h.organizationId,
      exportId,
      includeRecordingLinks: false,
      traceId: 't',
      receiveCount: 1,
      signal,
      pageSize: 2,
    })

    const calls = await rowsOf(h, h.organizationId, 'transcripts')
    expect(calls.map((c) => c.id).sort()).toEqual([...ids].sort())
    expect(await rowsOf(h, h.organizationId, 'deals')).toHaveLength(3)
    expect(await rowsOf(h, h.organizationId, 'documents')).toHaveLength(1)
    expect(JSON.stringify(calls)).not.toContain('theirs')
    expect(
      (await h.deps.objects.list(other, { prefix: `${prefix}/`, limit: 10 })).items
    ).toHaveLength(0)
  })
})
