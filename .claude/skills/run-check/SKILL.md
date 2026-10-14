---
name: run-check
description: Runs the change for real after the gate is green. Starts the local stack, runs the smoke test and the Postgres integration suite, then exercises the changed routes or screens (agent-browser for the portal) and writes a "Run check" report. Use after implementing any feature or fix, as part of /review-loop, or when asked to "run it", "try it for real" or "check it works".
---

# Run check

Passing unit tests is not enough. Run the change against the real stack.
Anything this reveals is a finding: fix it test-first, like a review finding.

1. **Start the stack.** From the hub clone (`../tula-closeline`): `bun run dev`. Docker must be
   running; if it is not, report a blocker, do not skip. Confirm every service the stack starts is
   up (see `docs/local-development.md` in the hub; do not assume a fixed list). One stack serves
   every session on the machine: if it is already running, reuse it and leave it running for its
   owner, and run the clone you changed against it.
2. **Smoke.** `bun run dev:smoke --strict` in the hub.
3. **Integration.** In this repo, `bun run test:integration` (or its equivalent in `package.json`)
   against Docker.
4. **Exercise the change** for real:
   - Service: call the changed routes over HTTP with a real token from the smoke flow. Include one
     failure case and a second-Organization isolation check.
   - Portal: use `agent-browser` (load the `agent-browser` skill first) to walk the changed screens:
     one happy path, one error path, keyboard focus and labels present, and a screenshot of each
     state. Upload real files where the feature takes uploads.
   - Library: in an unmerged PR only, bump a consumer to the branch and run the consumer's check.
5. **Report.**
   ```
   Run check: <pass | fail | blocked>
   Commands:  <each command run>
   Exercised: <routes or screens, happy / failure / isolation>
   Evidence:  <paths to outputs and screenshots, in the scratchpad>
   Not run:   <what and why>
   ```
6. **Stop** a stack you started: `bun run dev --down` in the hub. Never `--volumes` unless asked.

Use only test accounts and local origins. Never put evidence in the repo.
