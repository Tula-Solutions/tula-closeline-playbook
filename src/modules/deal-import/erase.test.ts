import { describe, expect, test } from 'bun:test'
import { dealImportSchema } from 'tula-closeline-contract'
import { DEAL_IMPORT_OBJECT_REMOVED, DEAL_IMPORT_PURGE_BATCH } from 'tula-closeline-db'
import { StorageError } from 'tula-closeline-kit'
import { postgresError } from '~/adapters/memory/playbook-database'
import { INTERNAL_SECRET, newKey } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'
import { IMPORT_PURGE_STEP_ROWS, IMPORTS_ERASED_PER_REQUEST } from './erase'
import { importObjectKey } from './keys'
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

describe('an interrupted erasure is finished by the next request', () => {
  /** An Organization with an import that has a multi-step report, one that is still queued, and their files. */
  async function seeded() {
    const h = await createImportHarness({ env: { MAX_DEALS_PER_ORGANIZATION: '100000' } })
    await h.uploadCsv(
      csv(Array.from({ length: IMPORT_PURGE_STEP_ROWS * 2 + 5 }, (_, i) => `D${i},open,,,,`))
    )
    await h.runImports()
    await h.uploadCsv(csv(['Q,open,,,,']), { key: newKey() })
    return h
  }

  /** Repeats remove-all until it answers something other than 503; returns every status. */
  async function untilDone(h: Harness): Promise<number[]> {
    const statuses: number[] = []
    for (let call = 0; call < 30; call++) {
      const { status } = await removeAll(h, h.organizationId)
      statuses.push(status)
      if (status !== 503) {
        break
      }
    }
    return statuses
  }

  async function expectNothingLeft(h: Harness): Promise<void> {
    expect(h.deps.database.imports(h.organizationId)).toEqual([])
    expect(h.deps.database.deals(h.organizationId)).toEqual([])
    expect(await h.objectKeys()).toEqual([])
  }

  test('a failure on the second purge step', async () => {
    const h = await seeded()
    const base = h.deps.scope
    let purges = 0
    h.deps.scope = (organizationId, work) =>
      base(organizationId, (run) =>
        work(async (text, params) => {
          if (text === DEAL_IMPORT_PURGE_BATCH && ++purges === 2) {
            throw new Error('connection lost')
          }
          return run(text, params)
        })
      )

    const first = await removeAll(h, h.organizationId)
    expect(first.status).toBe(500)
    expect(h.deps.database.imports(h.organizationId).length).toBeGreaterThan(0)
    const statuses = await untilDone(h)

    expect(statuses.at(-1)).toBe(200)
    await expectNothingLeft(h)
  })

  test('a failure recording that the file was removed', async () => {
    const h = await seeded()
    h.deps.database.failNext(DEAL_IMPORT_OBJECT_REMOVED, new Error('the schema is wrong'))

    const first = await removeAll(h, h.organizationId)
    expect(first.status).toBe(500)
    const statuses = await untilDone(h)

    expect(statuses.at(-1)).toBe(200)
    await expectNothingLeft(h)
  })

  test.each([
    ['a dropped database connection', '08006'],
    ['a server shutdown', '57P01'],
    ['a serialization failure that outlasted its retries', '40001'],
  ])('%s answers 503 with Retry-After, and the repeat reaches 200', async (_label, code) => {
    const h = await seeded()
    h.deps.database.failNext(DEAL_IMPORT_OBJECT_REMOVED, postgresError(code))
    h.deps.database.failNext(DEAL_IMPORT_PURGE_BATCH, postgresError(code))

    const first = await removeAll(h, h.organizationId)

    expect(first.status).toBe(503)
    expect(first.headers.get('retry-after')).not.toBeNull()
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe(
      'server.unavailable'
    )
    const statuses = await untilDone(h)
    expect(statuses.at(-1)).toBe(200)
    await expectNothingLeft(h)
  })

  test('an object store that is unavailable answers 503, and the repeat reaches 200', async () => {
    const h = await seeded()
    const original = h.deps.objects.delete.bind(h.deps.objects)
    let failures = 1
    h.deps.objects.delete = async (...args) => {
      if (failures-- > 0) {
        throw new StorageError('storage.unavailable', 'the store did not answer')
      }
      return original(...args)
    }

    const first = await removeAll(h, h.organizationId)

    expect(first.status).toBe(503)
    expect(first.headers.get('retry-after')).not.toBeNull()
    const statuses = await untilDone(h)
    expect(statuses.at(-1)).toBe(200)
    await expectNothingLeft(h)
  })

  test('a store that refuses for good stays an error, never 200 while data remains', async () => {
    const h = await seeded()
    h.deps.objects.delete = async () => {
      throw new StorageError('storage.rejected', 'access denied')
    }

    const first = await removeAll(h, h.organizationId)
    const second = await removeAll(h, h.organizationId)

    expect(first.status).toBe(500)
    expect(second.status).toBe(500)
    expect(h.deps.database.imports(h.organizationId).length).toBeGreaterThan(0)
  })

  test('a failure deleting the file right after the import was erased', async () => {
    const h = await seeded()
    const original = h.deps.objects.delete.bind(h.deps.objects)
    let failures = 1
    h.deps.objects.delete = async (...args) => {
      if (failures-- > 0) {
        throw new Error('storage is down')
      }
      return original(...args)
    }

    const first = await removeAll(h, h.organizationId)
    expect(first.status).toBe(500)
    expect(h.deps.database.imports(h.organizationId).some((i) => i.erased_at !== null)).toBe(true)
    const statuses = await untilDone(h)

    expect(statuses.at(-1)).toBe(200)
    await expectNothingLeft(h)
  })

  test('erased imports are finished before more are erased, within the per-request bound', async () => {
    const h = await createImportHarness()
    for (let i = 0; i < IMPORTS_ERASED_PER_REQUEST + 2; i++) {
      h.deps.database.seedImport({
        id: `dimp_${i.toString(16).padStart(32, '0')}`,
        organization_id: h.organizationId,
        erased_at: 1,
      })
    }

    const first = await removeAll(h, h.organizationId)

    expect(first.status).toBe(503)
    expect(h.deps.database.imports(h.organizationId)).toHaveLength(2)
    expect((await removeAll(h, h.organizationId)).status).toBe(200)
  })
})

describe('a file left behind by an import that ended is removed too', () => {
  // DEAL_IMPORT_FINISH and DEAL_IMPORT_FAIL record the file as removed before the best-effort delete,
  // so an import whose delete failed lists as not pending while its CSV is still stored.
  const ended: [label: string, text: string][] = [
    ['completed', csv(['A,won,,,,'])],
    ['failed', 'deal_id,outcome,closed_at,amount,currency\nA,won,,,"open\n'],
  ]

  async function leftBehind(text: string) {
    const h = await createImportHarness()
    const response = await h.uploadCsv(text)
    const id = dealImportSchema.parse(await response.json()).id
    await h.runImports()
    expect(await h.objectKeys()).toEqual([])
    await h.deps.objects.put(h.organizationId, importObjectKey(id), new TextEncoder().encode(text))
    expect(h.deps.database.imports(h.organizationId)[0]?.object_removed_at).not.toBeNull()
    return h
  }

  test.each(ended)(
    'a %s import: remove-all answers 200 and the store is empty',
    async (_label, text) => {
      const h = await leftBehind(text)

      let status = 503
      for (let call = 0; call < 10 && status === 503; call++) {
        status = (await removeAll(h, h.organizationId)).status
      }

      expect(status).toBe(200)
      expect(await h.objectKeys()).toEqual([])
      expect(h.deps.database.imports(h.organizationId)).toEqual([])
    }
  )

  test.each(ended)(
    'a %s import: with the store failing, remove-all does not answer 200',
    async (_label, text) => {
      const h = await leftBehind(text)
      const original = h.deps.objects.delete.bind(h.deps.objects)
      h.deps.objects.delete = async () => {
        throw new Error('storage is down')
      }

      const failed = await removeAll(h, h.organizationId)
      h.deps.objects.delete = original

      expect(failed.status).not.toBe(200)
      expect(h.deps.database.imports(h.organizationId)).toHaveLength(1)
      let status = 503
      for (let call = 0; call < 10 && status === 503; call++) {
        status = (await removeAll(h, h.organizationId)).status
      }
      expect(status).toBe(200)
      expect(await h.objectKeys()).toEqual([])
    }
  )
})
