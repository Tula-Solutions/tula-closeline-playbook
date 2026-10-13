---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.integration.ts"
  - "bench/**"
---

# Testing rules

- `bun:test` only. Colocate tests next to the code (`service.ts` → `service.test.ts`).
- Build dependencies with `createTestDeps(overrides?)`: memory adapters plus a fixed, advanceable
  clock. Advance time with `deps.clock.advance('10m')` instead of sleeping.
- No network, no Docker and no real vendor in unit tests. Tests that need Postgres or a queue are
  `*.integration.ts`.
- Every port has one behaviour suite that runs against each of its adapters, memory included.
- Prefer `spyOn(obj, 'fn')` with `mockRestore()` over `mock.module`, which is process-global in Bun.
- Bun's `toMatchObject` does not compare `Date`s: two different dates match. Use `toEqual` for a
  time, and for a boundary in time make the mutation once and see the test fail.
- Test behaviour through the public function or HTTP route (`app.request`), not private helpers.
- Test the failure paths first: expired, reused, wrong Organization, missing Contact Consent,
  vendor timeout, malformed input, duplicate delivery of the same event.
- Every tenant table has a test proving a second Organization cannot read or write its rows.
- Table-driven tests (`test.each`) for policies and state transitions.
- A regression test for a bug or review finding must fail before the fix. Name it after the
  behaviour: `test('a retried webhook books the meeting once')`.
- A benchmark in `bench/` measures one operation at a stated input size and asserts a budget.
  Use fixed seeds and memory adapters so the number reflects the code, not the network.
- A spawn in a test has its own `timeout`. Never set `timeout` under `[test]` in `bunfig.toml`;
  Bun ignores it.
