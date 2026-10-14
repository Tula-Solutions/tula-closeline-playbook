import { describe, expect, test } from 'bun:test'
import { type CallSearchState, type MomentTag, momentMayBeReturned } from './eligibility'

const tag: MomentTag = { outcome: 'won', outcomeSeq: 3, epoch: 2, repSeq: 1 }
const call: CallSearchState = { inSearch: true, epoch: 2, repSeq: 1 }

describe('momentMayBeReturned', () => {
  test('returns a won Moment of the Call build that is in search', () => {
    expect(momentMayBeReturned(tag, call)).toBe(true)
  })

  test('holds back a Moment whose own tag is not won, even when Postgres says in search', () => {
    expect(momentMayBeReturned({ ...tag, outcome: 'open' }, call)).toBe(false)
    expect(momentMayBeReturned({ ...tag, outcome: 'lost' }, call)).toBe(false)
  })

  test('holds back every Moment of a Call Postgres says is not in search', () => {
    expect(momentMayBeReturned(tag, { ...call, inSearch: false })).toBe(false)
  })

  test('holds back a vector of an earlier epoch or Rep sequence', () => {
    expect(momentMayBeReturned({ ...tag, epoch: 1 }, call)).toBe(false)
    expect(momentMayBeReturned({ ...tag, repSeq: 0 }, call)).toBe(false)
    expect(momentMayBeReturned({ ...tag, repSeq: 2 }, call)).toBe(false)
  })
})
