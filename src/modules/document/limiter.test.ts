import { describe, expect, test } from 'bun:test'
import { createConcurrencyGate, createOrganizationShare } from './limiter'

describe('createConcurrencyGate', () => {
  test('lets in up to the bound and then refuses without waiting', () => {
    const gate = createConcurrencyGate(2)

    const first = gate.tryAcquire()
    const second = gate.tryAcquire()

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(gate.tryAcquire()).toBeUndefined()
    expect(gate.active).toBe(2)
  })

  test('gives a place back once, however often release is called', () => {
    const gate = createConcurrencyGate(1)
    const release = gate.tryAcquire()

    release?.()
    release?.()

    expect(gate.active).toBe(0)
    expect(gate.tryAcquire()).toBeDefined()
    expect(gate.tryAcquire()).toBeUndefined()
  })
})

describe('createOrganizationShare', () => {
  test.each([
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 2],
    [16, 8],
  ])('with %i places one Organization may hold %i', (places, share) => {
    const shares = createOrganizationShare(places)

    const held = Array.from({ length: places }, () => shares.tryAcquire('org_a')).filter(Boolean)

    expect(held).toHaveLength(share)
  })

  test('counts each Organization on its own and forgets one that has let go', () => {
    const shares = createOrganizationShare(2)
    const a = shares.tryAcquire('org_a')

    expect(shares.tryAcquire('org_a')).toBeUndefined()
    expect(shares.tryAcquire('org_b')).toBeDefined()
    a?.()
    a?.()
    expect(shares.tryAcquire('org_a')).toBeDefined()
    expect(shares.organizations).toBe(2)
  })

  test('holds no entry for an Organization once all its places are returned', () => {
    const shares = createOrganizationShare(4)

    shares.tryAcquire('org_a')?.()

    expect(shares.organizations).toBe(0)
  })

  test('with one place the share is the whole gate', () => {
    const shares = createOrganizationShare(1)

    expect(shares.tryAcquire('org_a')).toBeDefined()
    expect(shares.tryAcquire('org_a')).toBeUndefined()
    expect(shares.tryAcquire('org_b')).toBeDefined()
  })
})
