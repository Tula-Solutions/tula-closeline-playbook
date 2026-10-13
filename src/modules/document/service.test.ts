import { describe, expect, test } from 'bun:test'
import { formatId, type Role } from 'tula-closeline-contract'
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
