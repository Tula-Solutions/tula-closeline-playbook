import { describe, expect, test } from 'bun:test'
import { formatId, type Role } from 'tula-closeline-contract'
import {
  DOCUMENT_REQUEUE,
  DOCUMENT_RESTORE_FOR_UPLOAD,
  IDEMPOTENCY_BEGIN,
  QUOTA_LOCK,
} from 'tula-closeline-db'
import { createTestDeps, newOrganizationId, newUserId } from '~/testing'
import { LOCK_TIMEOUT_SQL } from './idempotency'
import * as Documents from './service'
import { pdfBytes } from './test-support'

function contextAs(role: Role): Documents.CallContext {
  return {
    userId: newUserId(),
    organizationId: newOrganizationId(),
    role,
    requestId: formatId('req', crypto.randomUUID()),
  }
}

describe('the service checks the role itself, whatever the route did', () => {
  const id = formatId('doc', crypto.randomUUID())

  test.each(['manager', 'rep'] as const)('a %s cannot upload, delete or restore', async (role) => {
    const deps = createTestDeps()
    const context = contextAs(role)

    await expect(
      Documents.upload(deps, context, {
        fileName: 'a.pdf',
        declaredMediaType: null,
        bytes: pdfBytes('a'),
        idempotencyKey: undefined,
      })
    ).rejects.toMatchObject({ code: 'auth.forbidden' })
    await expect(Documents.remove(deps, context, id)).rejects.toMatchObject({
      code: 'auth.forbidden',
    })
    await expect(Documents.restore(deps, context, id)).rejects.toMatchObject({
      code: 'auth.forbidden',
    })
    expect(deps.database.transactions).toEqual([])
  })
})

describe('the lock order of an upload transaction (the db library requires the key before the upload lock)', () => {
  test('every transaction that takes the upload lock inserts its idempotency key first', async () => {
    const deps = createTestDeps()
    const context = {
      userId: newUserId(),
      organizationId: newOrganizationId(),
      role: 'owner' as const,
      requestId: formatId('req', crypto.randomUUID()),
    }
    await Documents.upload(deps, context, {
      fileName: 'a.txt',
      declaredMediaType: null,
      bytes: new TextEncoder().encode('hello there'),
      idempotencyKey: 'order-1',
    })
    // A replay and a second, different upload exercise the other paths through the transaction.
    await Documents.upload(deps, context, {
      fileName: 'a.txt',
      declaredMediaType: null,
      bytes: new TextEncoder().encode('hello there'),
      idempotencyKey: 'order-1',
    })
    await Documents.upload(deps, context, {
      fileName: 'b.txt',
      declaredMediaType: null,
      bytes: new TextEncoder().encode('another file'),
      idempotencyKey: 'order-2',
    })

    const locking = deps.database.transactionStatements.filter((statements) =>
      statements.includes(QUOTA_LOCK)
    )
    expect(locking.length).toBeGreaterThan(0)
    for (const statements of locking) {
      expect(statements.indexOf(IDEMPOTENCY_BEGIN)).toBeGreaterThanOrEqual(0)
      expect(statements.indexOf(IDEMPOTENCY_BEGIN)).toBeLessThan(statements.indexOf(QUOTA_LOCK))
    }
  })

  test('the restore-by-upload and failed-document re-upload branches keep the same order', async () => {
    const deps = createTestDeps()
    const context = {
      userId: newUserId(),
      organizationId: newOrganizationId(),
      role: 'owner' as const,
      requestId: formatId('req', crypto.randomUUID()),
    }
    const send = (name: string, text: string, key: string) =>
      Documents.upload(deps, context, {
        fileName: name,
        declaredMediaType: null,
        bytes: new TextEncoder().encode(text),
        idempotencyKey: key,
      })
    // A deleted document uploaded again is restored.
    const gone = (await send('a.txt', 'content of a', 'k-1')).document
    await Documents.remove(deps, context, gone.id)
    await send('a.txt', 'content of a', 'k-2')
    // A failed document uploaded again is requeued.
    const failed = (await send('b.txt', 'content of b', 'k-3')).document
    deps.database.update(context.organizationId, failed.id, {
      state: 'failed',
      failure_reason: 'no_text',
    })
    await send('b.txt', 'content of b', 'k-4')

    const all = deps.database.transactionStatements
    const branch = (statement: string) => all.filter((statements) => statements.includes(statement))
    expect(branch(DOCUMENT_RESTORE_FOR_UPLOAD).length).toBeGreaterThan(0)
    expect(branch(DOCUMENT_REQUEUE).length).toBeGreaterThan(0)
    for (const statements of all.filter((x) => x.includes(QUOTA_LOCK))) {
      expect(statements.indexOf(IDEMPOTENCY_BEGIN)).toBeGreaterThanOrEqual(0)
      expect(statements.indexOf(IDEMPOTENCY_BEGIN)).toBeLessThan(statements.indexOf(QUOTA_LOCK))
    }
  })
})

describe('the upload attempt record', () => {
  test('its transaction sets the lock timeout before it takes any lock', async () => {
    const deps = createTestDeps()
    const context = {
      userId: newUserId(),
      organizationId: newOrganizationId(),
      role: 'owner' as const,
      requestId: formatId('req', crypto.randomUUID()),
    }
    await Documents.upload(deps, context, {
      fileName: 'a.txt',
      declaredMediaType: null,
      bytes: new TextEncoder().encode('hello there'),
      idempotencyKey: undefined,
    })

    const attempt = deps.database.transactionStatements.filter(
      (statements) => statements.includes(IDEMPOTENCY_BEGIN) && !statements.includes(QUOTA_LOCK)
    )
    expect(attempt).toHaveLength(1)
    expect(attempt[0]?.[0]).toBe(LOCK_TIMEOUT_SQL)
  })
})
