import { describe, expect, test } from 'bun:test'
import {
  type DocumentId,
  formatId,
  internalRemoveOrganizationDocumentsResponseSchema,
  organizationIdSchema,
} from 'tula-closeline-contract'
import { newOrganizationId } from '~/testing'
import * as Documents from './service'
import { DEAL_ERASE_BATCH_SIZE, ERASE_BATCH_SIZE, ERASE_BATCHES_PER_REQUEST } from './service'
import {
  createDocumentHarness,
  DOCUMENTS,
  errorCode,
  INTERNAL_SECRET,
  newKey,
  pdfBytes,
  personIn,
} from './test-support'

const organizationIdOf = (id: string) => organizationIdSchema.parse(id)

const removeAllPath = (organizationId: string) =>
  `/internal/playbook/organizations/${organizationId}/remove-all`

function seedDocuments(
  h: Awaited<ReturnType<typeof createDocumentHarness>>,
  organizationId: string,
  count: number,
  state: 'ready' | 'deleted' = 'ready'
): DocumentId[] {
  const ids: DocumentId[] = []
  for (let i = 0; i < count; i++) {
    const id = formatId('doc', crypto.randomUUID())
    ids.push(id)
    h.deps.database.seed({
      id,
      organization_id: organizationId,
      state,
      ...(state === 'deleted'
        ? { deleted_at: Date.now(), purge_due_at: Date.now() + 86_400_000, deletion_seq: 1 }
        : {}),
    })
  }
  return ids
}

async function removeAll(
  h: Awaited<ReturnType<typeof createDocumentHarness>>,
  organizationId: string,
  options: { secret?: string | null; key?: string | null; headers?: Record<string, string> } = {}
) {
  const secret = options.secret === undefined ? INTERNAL_SECRET : options.secret
  const key = options.key === undefined ? newKey() : options.key
  return h.app.request(removeAllPath(organizationId), {
    method: 'POST',
    headers: {
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
      ...(key === null ? {} : { 'idempotency-key': key }),
      ...options.headers,
    },
  })
}

describe('the internal remove-all route: who may call', () => {
  test('a missing or wrong secret is auth.unauthenticated and removes nothing', async () => {
    const h = await createDocumentHarness()
    seedDocuments(h, h.organizationId, 2)

    for (const secret of [null, 'not-the-secret-at-all-not-the-secret-at-all']) {
      const response = await removeAll(h, h.organizationId, { secret })
      expect(response.status).toBe(401)
      expect(await errorCode(response)).toBe('auth.unauthenticated')
    }
    expect(h.deps.database.documents(h.organizationId).map((d) => d.state)).toEqual([
      'ready',
      'ready',
    ])
  })

  test('a user access token, even an Owner of that Organization, is not the secret', async () => {
    const h = await createDocumentHarness()
    seedDocuments(h, h.organizationId, 1)
    const { authorization } = await h.bearer(h.people.owner)

    const response = await removeAll(h, h.organizationId, {
      secret: null,
      headers: { authorization },
    })

    expect(response.status).toBe(401)
    expect(h.deps.database.documents(h.organizationId).map((d) => d.state)).toEqual(['ready'])
  })

  test('the secret does not open the public routes, and the public routes stay out of the secret guard', async () => {
    const h = await createDocumentHarness()

    const withSecret = await h.app.request(DOCUMENTS, {
      headers: { authorization: `Bearer ${INTERNAL_SECRET}` },
    })
    const health = await h.app.request('/healthz')

    expect(withSecret.status).toBe(401)
    expect(health.status).toBe(200)
  })

  test('a rotation accepts either of the two secrets', async () => {
    const next = 'the-next-secret-of-at-least-32-characters-x'
    const h = await createDocumentHarness({
      env: { INTERNAL_API_TOKENS: `${INTERNAL_SECRET},${next}` },
    })

    expect((await removeAll(h, h.organizationId, { secret: next })).status).toBe(200)
    expect((await removeAll(h, h.organizationId, { secret: INTERNAL_SECRET })).status).toBe(200)
  })

  test('a call without an Idempotency-Key, or with a malformed one, is request.invalid', async () => {
    const h = await createDocumentHarness()

    expect((await removeAll(h, h.organizationId, { key: null })).status).toBe(400)
    expect((await removeAll(h, h.organizationId, { key: 'short' })).status).toBe(400)
  })

  test('a malformed Organization id in the path is request.invalid', async () => {
    const h = await createDocumentHarness()

    expect((await removeAll(h, 'org_not-an-id')).status).toBe(400)
  })
})

describe('the internal remove-all route: what it removes', () => {
  test('erases the Deals and the rights confirmation of the named Organization only, in bounded batches', async () => {
    const h = await createDocumentHarness()
    const other = newOrganizationId()
    for (let i = 1; i <= 3; i++) {
      h.deps.database.seedDeal({
        id: `deal_${i.toString(16).padStart(32, '0')}`,
        organization_id: h.organizationId,
        deal_id: `D-${i}`,
      })
    }
    h.deps.database.seedDeal({
      id: `deal_${'f'.repeat(32)}`,
      organization_id: other,
      deal_id: 'D-1',
    })
    for (const organizationId of [h.organizationId, other]) {
      h.deps.database.seedRights({
        organization_id: organizationId,
        confirmed_by: 'usr_x',
        confirmed_at: Date.now(),
        wording_version: 1,
      })
    }

    const response = await removeAll(h, h.organizationId)

    expect(response.status).toBe(200)
    expect(h.deps.database.deals(h.organizationId)).toEqual([])
    expect(h.deps.database.rights(h.organizationId)).toBeUndefined()
    expect(h.deps.database.deals(other)).toHaveLength(1)
    expect(h.deps.database.rights(other)).toBeDefined()
  })

  test('answers 503 while Deals remain after the batches of one request, and 200 once a repeat has erased them', async () => {
    const h = await createDocumentHarness()
    const count = ERASE_BATCHES_PER_REQUEST * DEAL_ERASE_BATCH_SIZE + 1
    for (let i = 1; i <= count; i++) {
      h.deps.database.seedDeal({
        id: `deal_${i.toString(16).padStart(32, '0')}`,
        organization_id: h.organizationId,
        deal_id: `D-${i}`,
      })
    }

    const first = await removeAll(h, h.organizationId)

    expect(first.status).toBe(503)
    expect(h.deps.database.deals(h.organizationId)).toHaveLength(1)
    expect(h.deps.database.keys(h.organizationId)).toEqual([])
    expect((await removeAll(h, h.organizationId)).status).toBe(200)
    expect(h.deps.database.deals(h.organizationId)).toEqual([])
  })

  test('an Organization with nothing is removed at once: 200 removed', async () => {
    const h = await createDocumentHarness()

    const response = await removeAll(h, h.organizationId)

    expect(response.status).toBe(200)
    expect(internalRemoveOrganizationDocumentsResponseSchema.parse(await response.json())).toEqual({
      organizationId: h.organizationId as never,
      status: 'removed',
    })
  })

  test('erases only the named Organization, soft-deleted documents included, and does not wait for retention', async () => {
    const h = await createDocumentHarness()
    const other = newOrganizationId()
    seedDocuments(h, h.organizationId, 2)
    seedDocuments(h, h.organizationId, 1, 'deleted')
    seedDocuments(h, other, 2)

    await removeAll(h, h.organizationId)

    const mine = h.deps.database.documents(h.organizationId)
    expect(mine.map((d) => d.state)).toEqual(['deleted', 'deleted', 'deleted'])
    expect(mine.every((d) => d.restore_barred_at !== null && d.purge_due_at !== null)).toBe(true)
    expect(mine.every((d) => (d.purge_due_at ?? Infinity) <= Date.now() + 1)).toBe(true)
    expect(h.deps.database.documents(other).map((d) => d.state)).toEqual(['ready', 'ready'])
  })

  test('publishes the cleanup of each document it deleted, and none for one that was deleted already', async () => {
    const h = await createDocumentHarness()
    const live = seedDocuments(h, h.organizationId, 2)
    seedDocuments(h, h.organizationId, 1, 'deleted')

    await removeAll(h, h.organizationId)

    expect(h.published.map((m) => (m.payload as { documentId: string }).documentId).sort()).toEqual(
      [...live].sort()
    )
    expect(h.published.every((m) => m.type === 'playbook.document_deleted')).toBe(true)
    expect(h.published.every((m) => m.organizationId === h.organizationId)).toBe(true)
  })

  test('answers 503 with Retry-After while documents remain, never "removed" early', async () => {
    const h = await createDocumentHarness()
    seedDocuments(h, h.organizationId, 2)

    const response = await removeAll(h, h.organizationId)

    expect(response.status).toBe(503)
    expect(await errorCode(response)).toBe('server.unavailable')
    expect(response.headers.get('retry-after')).toBe('30')
    expect(h.deps.database.keys(h.organizationId)).toEqual([])
  })

  test('answers 200 once the purge has removed the documents, and again for the same key or another', async () => {
    const h = await createDocumentHarness()
    seedDocuments(h, h.organizationId, 2)
    const key = newKey()
    expect((await removeAll(h, h.organizationId, { key })).status).toBe(503)

    h.deps.database.purgeAll(h.organizationId)
    const done = await removeAll(h, h.organizationId, { key })
    const again = await removeAll(h, h.organizationId, { key })
    const otherKey = await removeAll(h, h.organizationId)

    for (const response of [done, again, otherKey]) {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ organizationId: h.organizationId, status: 'removed' })
    }
    expect(h.deps.database.keys(h.organizationId).map((k) => k.route)).toContain(
      'organizations.remove_all'
    )
  })

  test('a repeat does the work that was left, and is idempotent by end state', async () => {
    const h = await createDocumentHarness()
    seedDocuments(h, h.organizationId, 3)

    await removeAll(h, h.organizationId)
    const publishedByFirst = h.published.length
    await removeAll(h, h.organizationId)

    expect(h.published).toHaveLength(publishedByFirst)
    expect(h.deps.database.documents(h.organizationId)).toHaveLength(3)
  })

  test('does a bounded amount of work per call, whatever the Organization holds', async () => {
    const h = await createDocumentHarness()
    const bound = ERASE_BATCH_SIZE * ERASE_BATCHES_PER_REQUEST
    seedDocuments(h, h.organizationId, bound + 50)

    const first = await removeAll(h, h.organizationId)
    const erasedAfterFirst = h.deps.database
      .documents(h.organizationId)
      .filter((d) => d.restore_barred_at !== null).length
    await removeAll(h, h.organizationId)
    const erasedAfterSecond = h.deps.database
      .documents(h.organizationId)
      .filter((d) => d.restore_barred_at !== null).length

    expect(first.status).toBe(503)
    expect(erasedAfterFirst).toBe(bound)
    expect(erasedAfterSecond).toBe(bound + 50)
  })

  test('publishes the cleanups of 300 documents with bounded concurrency, well inside the budget', async () => {
    const h = await createDocumentHarness()
    seedDocuments(h, h.organizationId, 300)
    h.publishing.delayMs = 20
    const startedAt = performance.now()

    const response = await removeAll(h, h.organizationId)

    const elapsed = performance.now() - startedAt
    expect(response.status).toBe(503)
    expect(h.published).toHaveLength(300)
    // One at a time these would take 6 s; eight at a time about 0.75 s.
    expect(elapsed).toBeLessThan(2500)
    expect(elapsed).toBeLessThan(Documents.PUBLISH_BUDGET_MS)
  })

  test('stops publishing when its budget is spent and leaves the rest to the sweep', async () => {
    const h = await createDocumentHarness()
    seedDocuments(h, h.organizationId, 100)
    h.publishing.delayMs = 20

    await expect(
      Documents.removeAll(
        h.deps,
        organizationIdOf(h.organizationId),
        formatId('req', crypto.randomUUID()),
        newKey(),
        {
          publishBudgetMs: 100,
        }
      )
    ).rejects.toMatchObject({ code: 'server.unavailable' })

    expect(h.published.length).toBeGreaterThan(0)
    expect(h.published.length).toBeLessThan(100)
    expect(h.deps.logLines.join('\n')).toContain('left cleanup messages for the sweep')
    expect(
      h.deps.database.documents(h.organizationId).every((d) => d.restore_barred_at !== null)
    ).toBe(true)
  })

  test('an upload that lands after the erase is not erased, never counts as removed, and is taken by the repeat', async () => {
    const h = await createDocumentHarness()
    seedDocuments(h, h.organizationId, 1)
    let late: Response | undefined
    h.publishing.before = async () => {
      late = await h.upload('late.pdf', pdfBytes('late'))
    }
    const key = newKey()

    const first = await removeAll(h, h.organizationId, { key })

    expect(late?.status).toBe(201)
    expect(first.status).toBe(503)
    expect(
      h.deps.database.documents(h.organizationId).filter((d) => d.restore_barred_at === null)
    ).toHaveLength(1)
    expect(h.deps.database.keys(h.organizationId).map((k) => k.route)).not.toContain(
      'organizations.remove_all'
    )

    const second = await removeAll(h, h.organizationId, { key })
    expect(second.status).toBe(503)
    h.deps.database.purgeAll(h.organizationId)
    const third = await removeAll(h, h.organizationId, { key })
    expect(third.status).toBe(200)
  })

  test('removes the usage and the rest only when no document row is left, keeping its own key', async () => {
    const h = await createDocumentHarness()
    seedDocuments(h, h.organizationId, 1)
    const key = newKey()
    await removeAll(h, h.organizationId, { key })
    h.deps.database.purgeAll(h.organizationId)

    const response = await removeAll(h, h.organizationId, { key })

    expect(response.status).toBe(200)
    const kept = h.deps.database.keys(h.organizationId)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.route).toBe('organizations.remove_all')
  })

  test('uploads by a real user and the sweep: the whole flow ends in 200', async () => {
    const h = await createDocumentHarness()
    const stranger = personIn(newOrganizationId(), 'owner')
    await h.upload('a.pdf', pdfBytes('a'))
    await h.upload('b.pdf', pdfBytes('b'), { as: stranger })

    expect((await removeAll(h, h.organizationId)).status).toBe(503)
    h.deps.database.purgeAll(h.organizationId)
    expect((await removeAll(h, h.organizationId)).status).toBe(200)

    const listed = await h.call('GET', DOCUMENTS, { as: stranger })
    expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1)
  })
})
