import { describe, expect, test } from 'bun:test'
import { formatId, type Role } from 'tula-closeline-contract'
import { IDEMPOTENCY_BEGIN, QUOTA_LOCK } from 'tula-closeline-db'
import { createTestDeps, newOrganizationId, newUserId } from '~/testing'
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
})
