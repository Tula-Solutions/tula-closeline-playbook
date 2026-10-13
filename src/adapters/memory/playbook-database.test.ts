import { describe, expect, test } from 'bun:test'
import { createFixedClock } from 'tula-closeline-kit'
import { createMemoryPlaybookDatabase } from './playbook-database'

const ORG = `org_${'a'.repeat(32)}`
const ID = `doc_${'1'.repeat(32)}`

function database() {
  const db = createMemoryPlaybookDatabase({
    clock: createFixedClock(new Date('2026-01-01T00:00:00Z')),
  })
  db.seed({ id: ID, organization_id: ORG })
  return db
}

describe('the database double refuses what the table refuses', () => {
  test.each([
    ['rewriting created_at', { created_at: 1 }],
    ['rewriting the content hash', { content_hash: 'ff' }],
    ['moving epoch down', { epoch: -1 }],
    ['a deleted state with no deletion time', { state: 'deleted' as const }],
    ['a failed state with no reason', { state: 'failed' as const }],
  ])('%s', (_label, change) => {
    expect(() => database().update(ORG, ID, change)).toThrow()
  })

  test('a purge time before the deletion time', () => {
    expect(() =>
      database().update(ORG, ID, { state: 'deleted', deleted_at: 100, purge_due_at: 99 })
    ).toThrow()
  })

  test('a deletion moved back together with its purge time is allowed', () => {
    const db = database()

    db.update(ORG, ID, { state: 'deleted', deleted_at: 100, purge_due_at: 200 })
    db.update(ORG, ID, { deleted_at: 50, purge_due_at: 150 })

    expect(db.documents(ORG)[0]?.purge_due_at).toBe(150)
  })
})
