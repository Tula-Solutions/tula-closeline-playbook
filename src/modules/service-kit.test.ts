import { describe, expect, test } from 'bun:test'
import { StorageError } from 'tula-closeline-kit'
import { isTransientFailure } from './service-kit'

const withCode = (code: string, message = 'x') => Object.assign(new Error(message), { code })

describe('isTransientFailure', () => {
  test.each([
    '08000',
    '08001',
    '08003',
    '08006',
    '40001',
    '40P01',
    '57P01',
    '57P02',
    '57P03',
    '53300',
  ])('SQLSTATE %s is transient', (code) => {
    expect(isTransientFailure(withCode(code))).toBe(true)
  })

  test.each(['08P01', '08004', '08007', '23514', '42P01', '22007'])(
    'SQLSTATE %s is not transient: a repeat will not cure it',
    (code) => {
      expect(isTransientFailure(withCode(code))).toBe(false)
    }
  )

  // The driver is node-postgres under the db library's pool: a socket it loses on its own side has
  // no SQLSTATE, only a Node error code or one of its own messages (pg and pg-pool, lib/client.js, index.js).
  test.each(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'])(
    'a code-less driver failure %s is transient, also inside a cause chain',
    (code) => {
      expect(isTransientFailure(withCode(code))).toBe(true)
      expect(isTransientFailure(new Error('Failed query', { cause: withCode(code) }))).toBe(true)
    }
  )

  test.each([
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
  ])('the driver pool message "%s" is transient', (message) => {
    expect(isTransientFailure(new Error(message))).toBe(true)
    expect(isTransientFailure(new Error('Failed query', { cause: new Error(message) }))).toBe(true)
  })

  test('a plain error, an unknown code and a rejected store are not transient', () => {
    expect(isTransientFailure(new Error('connection lost'))).toBe(false)
    expect(isTransientFailure(withCode('EACCES'))).toBe(false)
    expect(isTransientFailure(new StorageError('storage.rejected', 'denied'))).toBe(false)
    expect(isTransientFailure(new StorageError('storage.unavailable', 'down'))).toBe(true)
  })
})
