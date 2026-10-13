import { describe, expect, test } from 'bun:test'
import { createConcurrencyGate } from './limiter'

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
