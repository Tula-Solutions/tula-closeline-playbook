import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { listCursorSchema, toDocument } from './schema'

const row = {
  id: formatId('doc', crypto.randomUUID()),
  name: 'Plan.pdf',
  state: 'ready',
  size_bytes: '1234',
  detected_type: 'pdf',
  uploaded_by: formatId('usr', crypto.randomUUID()),
  failure_reason: null,
  deleted_at: null,
  purge_due_at: null,
  page_count: null,
  created_at: '2026-10-13 12:34:56.123456+00',
  updated_at: '2026-10-13 12:35:00+00',
}

describe('toDocument', () => {
  test('reads the driver text forms: bigint as a string and timestamps as Postgres prints them', () => {
    expect(toDocument(row)).toMatchObject({
      sizeBytes: 1234,
      mediaType: 'application/pdf',
      createdAt: '2026-10-13T12:34:56.123Z',
      updatedAt: '2026-10-13T12:35:00.000Z',
      pageCount: null,
    })
  })

  test('also reads a Date, and an offset that is not UTC', () => {
    const document = toDocument({
      ...row,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: '2026-10-13 14:35:00+02',
    })

    expect(document.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(document.updatedAt).toBe('2026-10-13T12:35:00.000Z')
  })

  test('a deleted row needs both its times, as the contract says', () => {
    expect(() => toDocument({ ...row, state: 'deleted' })).toThrow()
    expect(
      toDocument({
        ...row,
        state: 'deleted',
        deleted_at: '2026-10-13 12:00:00+00',
        purge_due_at: '2026-11-12 12:00:00+00',
      }).purgeAt
    ).toBe('2026-11-12T12:00:00.000Z')
  })

  test('refuses a row the database should never give: an unknown type, a timestamp that is not one', () => {
    expect(() => toDocument({ ...row, detected_type: 'exe' })).toThrow()
    expect(() => toDocument({ ...row, created_at: 'yesterday' })).toThrow()
  })
})

describe('listCursorSchema', () => {
  test.each([
    [{ t: '2026-10-13 12:34:56.123456+00', i: row.id }, true],
    [{ t: '2026-13-45 99:99:99+00', i: row.id }, false],
    [{ t: "2026-10-13'; drop table x; --", i: row.id }, false],
    [{ t: '2026-10-13 12:34:56+00', i: 'doc_short' }, false],
    [{ t: '2026-10-13 12:34:56+00', i: row.id, extra: 1 }, false],
  ])('%j parses: %p', (value, ok) => {
    expect(listCursorSchema.safeParse(value).success).toBe(ok)
  })
})
