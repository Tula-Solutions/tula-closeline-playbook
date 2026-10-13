import { describe, expect, test } from 'bun:test'
import { canonicalJson, requestHashOf } from './idempotency'

describe('requestHashOf', () => {
  test('is 32 bytes and does not depend on key order', () => {
    const a = requestHashOf('documents.upload', { fileName: 'a.pdf', contentHash: 'ab' })
    const b = requestHashOf('documents.upload', { contentHash: 'ab', fileName: 'a.pdf' })

    expect(a).toHaveLength(32)
    expect(a.equals(b)).toBe(true)
  })

  test('differs by route and by any value', () => {
    const base = requestHashOf('documents.upload', { fileName: 'a.pdf' })

    expect(base.equals(requestHashOf('documents.other', { fileName: 'a.pdf' }))).toBe(false)
    expect(base.equals(requestHashOf('documents.upload', { fileName: 'b.pdf' }))).toBe(false)
  })
})

describe('canonicalJson', () => {
  test('sorts keys, skips undefined and nests', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: undefined }], a: null })).toBe(
      '{"a":null,"b":[1,{"d":1}]}'
    )
  })
})
