---
name: verify
description: Run this repo's full quality gate (Biome, typecheck, tests with coverage, benchmarks, dist and shared-setup drift), fix whatever fails, and rerun until green. Use before /review-loop, before committing, or when asked to "verify", "check everything" or "make CI pass".
---

# Verify

1. Run `bun run verify` from the repo root. It is exactly what CI runs.
2. If it passes, report the pass table and stop.
3. If it fails, classify each failure and fix the **root cause**:
   - **Biome:** run `bun run check --write` for autofixable issues and fix the rest by hand. Never
     add `biome-ignore` without a same-line reason.
   - **Typecheck:** fix the types. No `any`, no `@ts-ignore`. `@ts-expect-error` only in tests,
     with a reason.
   - **Tests:** decide whether the code or the test is wrong. Never weaken an assertion or delete
     a test to get green.
   - **Coverage below threshold:** add behaviour tests for the uncovered branches, failure paths
     first.
   - **Benchmark over budget:** find the cause and fix the code. Raise a budget only with a
     written reason in the PR; never to get green.
   - **`dist:check` drift (libraries):** run `bun run build` and commit `dist/`.
   - **`shared:check` drift:** a synced file was edited here. Restore it, make the change in the
     hub's `shared/`, and run the hub's `scripts/sync-shared.sh`.
   - **`db:check` drift (db repo):** run `bun run db:generate`, review and commit the migration.
4. Rerun `bun run verify`. Repeat until green. If the same failure survives 3 fix attempts, stop
   and report it with your diagnosis.

## Report

```
| Gate          | Result   | Notes |
| check (biome) | ✅/❌     |       |
| typecheck     | ✅/❌     |       |
| tests + cov   | ✅/❌     | lines x% / functions y% |
| bench         | ✅/❌/n/a |       |
| dist          | ✅/❌/n/a |       |
| shared        | ✅/❌     |       |
```
