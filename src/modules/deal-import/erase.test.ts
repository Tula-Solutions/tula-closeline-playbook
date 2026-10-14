import { describe, expect, test } from 'bun:test'
import { DEAL_IMPORT_PURGE_BATCH } from 'tula-closeline-db'
import { INTERNAL_SECRET, newKey } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'
import { IMPORT_PURGE_STEP_ROWS, IMPORTS_ERASED_PER_REQUEST } from './erase'
import { createImportHarness, csv } from './test-support'

type Harness = Awaited<ReturnType<typeof createImportHarness>>

const removeAll = (h: Harness, organizationId: string) =>
  h.app.request(`/internal/playbook/organizations/${organizationId}/remove-all`, {
    method: 'POST',
    headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'idempotency-key': newKey() },
  })

describe('remove-all erases imports, their reports and their files', () => {
  test('a completed import, an active one and a failed one are all gone, with their objects and rows', async () => {
    const h = await createImportHarness()
    await h.uploadCsv(csv(['A,won,,,,', 'B,lost,,,,']))
    await h.runImports()
    await h.uploadCsv(csv(['C,open,,,,']), { key: newKey() }) // still `uploaded`: its file is stored
    await h.uploadCsv('deal_id,outcome,closed_at,amount,currency\nA,won,,,"\n') // fails unreadable when run
    await h.runImports()

    const response = await removeAll(h, h.organizationId)

    expect(response.status).toBe(200)
    expect(h.deps.database.imports(h.organizationId)).toEqual([])
    expect(h.deps.database.deals(h.organizationId)).toEqual([])
    expect(await h.objectKeys()).toEqual([])
  })

  test('the report is purged in steps, and an import with more rows than one step goes completely', async () => {
    const h = await createImportHarness()
    const count = IMPORT_PURGE_STEP_ROWS * 2 + 7
    await h.uploadCsv(csv(Array.from({ length: count }, (_, i) => `D${i},open,,,,`)))
    await h.runImports()
    const before = h.deps.database.statements.length

    const response = await removeAll(h, h.organizationId)

    // The Deals the import made are erased in their own bounded batches, so the first answer is 503.
    expect(response.status).toBe(503)
    const purges = h.deps.database.statements
      .slice(before)
      .filter((s) => s === DEAL_IMPORT_PURGE_BATCH)
    expect(purges).toHaveLength(3)
    expect(h.deps.database.imports(h.organizationId)).toEqual([])
  })

  test('only the named Organization is touched', async () => {
    const h = await createImportHarness()
    await h.uploadCsv(csv(['A,won,,,,']))
    await h.runImports()
    const other = newOrganizationId()
    h.deps.database.seedImport({ id: `dimp_${'7'.repeat(32)}`, organization_id: other })
    await h.deps.objects.put(
      other,
      `deal-imports/dimp_${'7'.repeat(32)}/original.csv`,
      new Uint8Array([1])
    )

    await removeAll(h, h.organizationId)

    expect(h.deps.database.imports(other)).toHaveLength(1)
    expect((await h.deps.objects.list(other, {})).items).toHaveLength(1)
  })

  test('a request erases a bounded number of imports and answers 503 until none remain', async () => {
    const h = await createImportHarness()
    const total = IMPORTS_ERASED_PER_REQUEST + 2
    for (let i = 0; i < total; i++) {
      h.deps.database.seedImport({
        id: `dimp_${i.toString(16).padStart(32, '0')}`,
        organization_id: h.organizationId,
      })
    }

    const first = await removeAll(h, h.organizationId)

    expect(first.status).toBe(503)
    expect(h.deps.database.imports(h.organizationId)).toHaveLength(2)
    expect((await removeAll(h, h.organizationId)).status).toBe(200)
    expect(h.deps.database.imports(h.organizationId)).toEqual([])
  })

  test('an object store that fails stops the request before any import is erased, and the repeat succeeds', async () => {
    const h = await createImportHarness()
    await h.uploadCsv(csv(['A,open,,,,']))
    await h.runImports()
    const original = h.deps.objects.delete.bind(h.deps.objects)
    h.deps.objects.delete = async () => {
      throw new Error('storage is down')
    }

    const failed = await removeAll(h, h.organizationId)
    const stillThere = h.deps.database.imports(h.organizationId)
    h.deps.objects.delete = original
    const repeated = await removeAll(h, h.organizationId)

    expect(failed.status).toBe(500)
    expect(stillThere).toHaveLength(1)
    expect(stillThere[0]?.erased_at).toBeNull()
    expect(repeated.status).toBe(200)
  })

  test('an import that was running is fenced: the job it had cannot write after the erase', async () => {
    const h = await createImportHarness()
    await h.uploadCsv(csv(['A,open,,,,']))
    const base = h.deps.objects.get.bind(h.deps.objects)
    h.deps.objects.get = async (...args) => {
      const stored = await base(...args)
      // The erasure lands while the job holds the file.
      await removeAll(h, h.organizationId)
      return stored
    }

    await h.runImports()

    expect(h.deps.database.deals(h.organizationId)).toEqual([])
    expect(h.deps.database.imports(h.organizationId)).toEqual([])
  })
})
