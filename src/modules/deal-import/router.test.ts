import { describe, expect, test } from 'bun:test'
import {
  dealImportSchema,
  encodeCursor,
  errorBodySchema,
  listDealImportsResponseSchema,
  MAX_DEAL_IMPORT_BYTES,
} from 'tula-closeline-contract'
import { DEAL_IMPORT_INSERT, DEAL_IMPORT_LIST, DEAL_IMPORT_ROWS_LIST } from 'tula-closeline-db'
import { StorageError } from 'tula-closeline-kit'
import { postgresError } from '~/adapters/memory/playbook-database'
import { UPLOAD_ATTEMPT_ROUTE } from '~/modules/document/service'
import { errorCode, newKey, personIn } from '~/modules/document/test-support'
import { newOrganizationId } from '~/testing'
import { assertImportable } from './service'
import { createImportHarness, csv, HEADER, IMPORTS } from './test-support'

/** A deal id and an amount nothing may ever print. */
const SECRET = 'ACME-SECRET-DEAL-7731'

describe('who may use the import routes', () => {
  test.each([
    ['POST', IMPORTS],
    ['GET', IMPORTS],
    ['GET', `${IMPORTS}/dimp_${'1'.repeat(32)}`],
    ['GET', `${IMPORTS}/dimp_${'1'.repeat(32)}/rows`],
  ])('%s %s needs a token and an Owner or Admin', async (method, path) => {
    const h = await createImportHarness()
    const send = (as: Parameters<typeof h.send>[2]) =>
      method === 'POST' ? h.uploadCsv(csv([]), as) : h.send(method, path, as)

    expect((await send({ as: null })).status).toBe(401)
    for (const role of ['manager', 'rep'] as const) {
      const denied = await send({ as: h.people[role] })
      expect(denied.status).toBe(403)
      expect(await errorCode(denied)).toBe('auth.forbidden')
    }
    for (const role of ['owner', 'admin'] as const) {
      expect([200, 202, 404]).toContain((await send({ as: h.people[role] })).status)
    }
    expect(await h.objectKeys()).toEqual(method === 'POST' ? expect.any(Array) : [])
  })

  test('a refused role stores nothing: no object, no import, no key', async () => {
    const h = await createImportHarness()

    await h.uploadCsv(csv([`${SECRET},won,,,,`]), { as: h.people.rep })

    expect(await h.objectKeys()).toEqual([])
    expect(h.deps.database.imports(h.organizationId)).toEqual([])
    expect(h.deps.database.keys(h.organizationId)).toEqual([])
  })
})

describe('what an upload refuses before it stores anything', () => {
  type Refusal = [
    label: string,
    make: () => string | Uint8Array,
    code: string,
    status: number,
    options?: { name?: string; type?: string },
  ]
  const refusals: Refusal[] = [
    [
      'a file over 10 MB',
      () => new Uint8Array(MAX_DEAL_IMPORT_BYTES + 1),
      'deal_import.too_large',
      413,
    ],
    [
      'a name that is not .csv',
      () => csv([]),
      'deal_import.unsupported_type',
      415,
      { name: 'deals.xlsx' },
    ],
    ['an empty file', () => '', 'deal_import.header_invalid', 422],
    [
      'a header missing a column',
      () => 'deal_id,outcome,closed_at,amount\n',
      'deal_import.header_invalid',
      422,
    ],
    [
      'a header in the wrong order',
      () => 'outcome,deal_id,closed_at,amount,currency\n',
      'deal_import.header_invalid',
      422,
    ],
    [
      'a header with an unexpected column',
      () => `${HEADER},extra\n`,
      'deal_import.header_invalid',
      422,
    ],
    ['a header with a bad quote', () => 'deal_id,"outcome\n', 'deal_import.header_invalid', 422],
    [
      'a header cell over the length limit',
      () => `${'x'.repeat(1500)},outcome\n`,
      'deal_import.header_invalid',
      422,
    ],
  ]
  test.each(refusals)('%s', async (_label, make, code, status, options = {}) => {
    const h = await createImportHarness()

    const response = await h.uploadCsv(make(), options)

    expect(response.status).toBe(status)
    expect(await errorCode(response)).toBe(code)
    expect(await h.objectKeys()).toEqual([])
    expect(h.deps.database.imports(h.organizationId)).toEqual([])
    expect(h.deps.database.keys(h.organizationId)).toEqual([])
  })

  test('a header refusal names the problem and never a cell', async () => {
    const h = await createImportHarness()

    const response = await h.uploadCsv(`${SECRET},outcome,closed_at,amount,currency\n`)
    const text = await response.text()

    expect(response.status).toBe(422)
    expect(errorBodySchema.parse(JSON.parse(text)).error.details).toEqual({
      problem: 'unexpected_column',
    })
    expect(text).not.toContain(SECRET)
  })

  test('a body over the cap is request.too_large and is not stored', async () => {
    const h = await createImportHarness()

    const response = await h.uploadCsv(new Uint8Array(MAX_DEAL_IMPORT_BYTES + 100_000))

    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('request.too_large')
    expect(await h.objectKeys()).toEqual([])
  })

  test('a header still unfinished in the first 8192 characters is left to the job', async () => {
    const h = await createImportHarness()
    const wide = `"${' '.repeat(990)}",`.repeat(10)

    const response = await h.uploadCsv(`deal_id,outcome,closed_at,amount,currency,${wide}x\n`)

    // The reader defers: the early check never refuses a header it has seen only part of.
    expect(response.status).toBe(202)
  })

  test.each([
    ['text/csv', true],
    ['application/vnd.ms-excel', true],
    ['', true],
    ['text/csv; charset=utf-8', true],
    ['image/png', false],
    ['application/pdf', false],
  ])('a declared type of %p is accepted: %p', (declaredMediaType, ok) => {
    const check = () =>
      assertImportable({
        fileName: 'deals.csv',
        declaredMediaType: declaredMediaType === '' ? null : declaredMediaType,
        sizeBytes: 10,
      })

    if (ok) {
      expect(check).not.toThrow()
    } else {
      expect(check).toThrow()
    }
  })
})

describe('storing an upload', () => {
  test('answers 202 with an uploaded import, stores the CSV under the import id and records one attempt', async () => {
    const h = await createImportHarness()

    const response = await h.uploadCsv(csv([`${SECRET},won,,,,`]), { name: 'Q3-customer-list.csv' })
    const body = dealImportSchema.parse(await response.json())

    expect(response.status).toBe(202)
    expect(body).toMatchObject({ state: 'uploaded', failureReason: null, rowCount: null })
    expect(await h.objectKeys()).toEqual([`deal-imports/${body.id}/original.csv`])
    expect(h.deps.database.imports(h.organizationId)[0]).toMatchObject({
      id: body.id,
      uploaded_by: h.people.owner.userId,
      size_bytes: new TextEncoder().encode(csv([`${SECRET},won,,,,`])).byteLength,
    })
    // No file name, no cell, in the answer or in any stored row.
    const everything = JSON.stringify([body, h.deps.database.imports(h.organizationId)])
    expect(everything).not.toContain('Q3-customer-list')
    expect(everything).not.toContain(SECRET)
    expect(h.deps.database.keys(h.organizationId).map((k) => k.route)).toEqual([
      UPLOAD_ATTEMPT_ROUTE,
    ])
  })

  test('the same key with the same file answers the first import and stores nothing again', async () => {
    const h = await createImportHarness()
    const key = newKey()

    const first = dealImportSchema.parse(
      await (await h.uploadCsv(csv(['A,won,,,,']), { key })).json()
    )
    const again = await h.uploadCsv(csv(['A,won,,,,']), { key })

    expect(again.status).toBe(202)
    expect(dealImportSchema.parse(await again.json()).id).toBe(first.id)
    expect(h.deps.database.imports(h.organizationId)).toHaveLength(1)
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test('the same key with another file is request.idempotency_key_reused and the extra object is removed', async () => {
    const h = await createImportHarness()
    const key = newKey()
    await h.uploadCsv(csv(['A,won,,,,']), { key })

    const other = await h.uploadCsv(csv(['B,lost,,,,']), { key })

    expect(other.status).toBe(422)
    expect(await errorCode(other)).toBe('request.idempotency_key_reused')
    expect(await h.objectKeys()).toHaveLength(1)
  })

  test('two uploads of the same file without a key are two imports (no content dedup)', async () => {
    const h = await createImportHarness()

    await h.uploadCsv(csv(['A,won,,,,']))
    await h.uploadCsv(csv(['A,won,,,,']))

    expect(h.deps.database.imports(h.organizationId)).toHaveLength(2)
  })

  test('the attempt record is committed before the object is written', async () => {
    const h = await createImportHarness()
    let keysWhenWritten: string[] = []
    const put = h.deps.objects.put.bind(h.deps.objects)
    h.deps.objects.put = async (...args) => {
      keysWhenWritten = h.deps.database.keys(h.organizationId).map((k) => k.route)
      return put(...args)
    }

    await h.uploadCsv(csv([]))

    expect(keysWhenWritten).toEqual([UPLOAD_ATTEMPT_ROUTE])
  })

  test('an object store that is down is a retryable 503 with no import row; the attempt stays for the sweep', async () => {
    const h = await createImportHarness()
    h.deps.objects.put = async () => {
      throw new StorageError('storage.unavailable', 'down')
    }

    const response = await h.uploadCsv(csv([]))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(h.deps.database.imports(h.organizationId)).toEqual([])
    expect(h.deps.database.keys(h.organizationId).map((k) => k.route)).toEqual([
      UPLOAD_ATTEMPT_ROUTE,
    ])
  })

  test('an insert that certainly rolled back removes the object it wrote', async () => {
    const h = await createImportHarness()
    h.deps.database.failNext(DEAL_IMPORT_INSERT, postgresError('23505'))

    const response = await h.uploadCsv(csv([]))

    expect(response.status).toBe(500)
    expect(await h.objectKeys()).toEqual([])
  })

  test('a commit whose outcome is unknown leaves the object for the orphan sweep', async () => {
    const h = await createImportHarness()
    const put = h.deps.objects.put.bind(h.deps.objects)
    h.deps.objects.put = async (...args) => {
      await put(...args)
      // The commit of the import row (the next one after the attempt record) fails after it applied.
      h.deps.database.failNextCommit(postgresError('57P01'), { applied: true })
    }

    await h.uploadCsv(csv([]))

    expect(await h.objectKeys()).toHaveLength(1)
    expect(h.deps.logLines.join('\n')).toContain('left in place')
  })

  test('shares the upload places with document uploads: a full instance is a 503 for both', async () => {
    const h = await createImportHarness({ env: { MAX_CONCURRENT_UPLOADS: '1' } })
    const { uploadGatesOf } = await import('~/modules/document/limiter')
    const taken = uploadGatesOf(h.deps, 1).gate.tryAcquire()

    const importResponse = await h.uploadCsv(csv([]))
    const documentResponse = await h.upload('a.txt', new TextEncoder().encode('hello'), {})

    expect(taken).toBeDefined()
    expect(importResponse.status).toBe(503)
    expect(documentResponse.status).toBe(503)
    taken?.()
    expect((await h.uploadCsv(csv([]))).status).toBe(202)
  })
})

describe('reading imports', () => {
  test('a second Organization can neither read nor list an import of the first', async () => {
    const h = await createImportHarness()
    const first = dealImportSchema.parse(await (await h.uploadCsv(csv(['A,won,,,,']))).json())
    const stranger = personIn(newOrganizationId(), 'owner')

    const read = await h.send('GET', `${IMPORTS}/${first.id}`, { as: stranger })
    const rows = await h.send('GET', `${IMPORTS}/${first.id}/rows`, { as: stranger })
    const listed = listDealImportsResponseSchema.parse(
      await (await h.send('GET', IMPORTS, { as: stranger })).json()
    )

    expect(read.status).toBe(404)
    expect(await errorCode(read)).toBe('deal_import.not_found')
    expect(rows.status).toBe(404)
    expect(listed.items).toEqual([])
  })

  test('a missing import is deal_import.not_found for a read and for the report', async () => {
    const h = await createImportHarness()
    const missing = `dimp_${'9'.repeat(32)}`

    for (const path of [`${IMPORTS}/${missing}`, `${IMPORTS}/${missing}/rows`]) {
      const response = await h.send('GET', path)
      expect(response.status).toBe(404)
      expect(await errorCode(response)).toBe('deal_import.not_found')
    }
  })

  test('lists newest first and continues by the text cursor', async () => {
    const h = await createImportHarness()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(dealImportSchema.parse(await (await h.uploadCsv(csv([`D${i},won,,,,`]))).json()).id)
    }

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const response = await h.send(
        'GET',
        `${IMPORTS}?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
      )
      const body = listDealImportsResponseSchema.parse(await response.json())
      seen.push(...body.items.map((i) => i.id))
      cursor = body.nextCursor
      if (cursor === null) {
        break
      }
    }

    expect(seen).toEqual([...ids].reverse())
  })

  test.each([
    ['a cursor that is not one', `${IMPORTS}?cursor=nope`],
    ['an unknown query key', `${IMPORTS}?name=x`],
    ['a limit of zero', `${IMPORTS}?limit=0`],
    ['an import id that is not one', `${IMPORTS}/D-1`],
    ['an unknown result filter', `${IMPORTS}/dimp_${'1'.repeat(32)}/rows?result=maybe`],
    ['a row cursor that is not one', `${IMPORTS}/dimp_${'1'.repeat(32)}/rows?cursor=nope`],
  ])('%s is request.invalid', async (_label, path) => {
    const h = await createImportHarness()

    const response = await h.send('GET', path)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('request.invalid')
  })

  test('a row cursor beyond the last possible row is request.invalid, and the statement is never run', async () => {
    const h = await createImportHarness()
    const id = dealImportSchema.parse(await (await h.uploadCsv(csv(['A,open,,,,']))).json()).id
    const before = h.deps.database.statements.length
    const cursor = encodeURIComponent(encodeCursor({ rowNumber: 2 ** 40 }))

    const response = await h.send('GET', `${IMPORTS}/${id}/rows?cursor=${cursor}`)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('request.invalid')
    expect(h.deps.database.statements.slice(before)).not.toContain(DEAL_IMPORT_ROWS_LIST)
  })

  test('a data exception from the report (SQLSTATE class 22) is request.invalid, not a 500', async () => {
    const h = await createImportHarness()
    const id = dealImportSchema.parse(await (await h.uploadCsv(csv(['A,open,,,,']))).json()).id
    h.deps.database.failNext(DEAL_IMPORT_ROWS_LIST, postgresError('22003', 'secret row text'))

    const response = await h.send('GET', `${IMPORTS}/${id}/rows`)
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(text).not.toContain('secret row text')
    expect(h.deps.reported).toEqual([])
  })

  test('a data exception from the list (SQLSTATE class 22) is request.invalid, not a 500', async () => {
    const h = await createImportHarness()
    h.deps.database.failNext(DEAL_IMPORT_LIST, postgresError('22008', 'secret cursor text'))

    const response = await h.send('GET', IMPORTS)
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(text).not.toContain('secret cursor text')
    expect(h.deps.reported).toEqual([])
  })
})
