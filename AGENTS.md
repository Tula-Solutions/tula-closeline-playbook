# tula-closeline-playbook

Closeline playbook service: ingestion, search and fine-tuning of an Organization's sales knowledge

Kind: **service**. Common standards for every Closeline repo are in `.claude/COMMON.md`, synced
from the hub (`tula-closeline`). This file holds only what is specific to this repo. Keep it under
200 lines: put detail in a path-scoped rule under `.claude/rules/` or a decision record in the hub.

## Commands

| Command | Use |
| --- | --- |
| `bun install` | install, including the tagged `tula-closeline-*` libraries |
| `bun run verify` | the full gate, exactly what CI runs |
| `bun run verify:changed` | the quick gate the Stop hook runs |
| `bun test` | tests |
| `bun run bench` | the benchmarks and their budgets |
| `bun run openapi` | rewrite `openapi.json` after a route or schema change |
| `docker compose up -d --wait && bun run test:integration` | the `*.integration.ts` suites against Postgres; CI runs them after `verify` |

Other scripts are in `package.json`.

## What this service owns

The Playbook of each Organization (ADR 0016): documents and their ingestion, the vectors and
search over them, and later fine-tuning. It owns the `playbook` Postgres schema (login
`closeline_playbook`), its bucket and its queue, and nothing else. It never reads the `core` or
`auth` schema; it asks core over HTTP or consumes events.

What exists: the skeleton (HTTP stack, token check, container, consumer loop, ports and fakes).
What does not: Playbook routes and pipeline steps (hub issue 14) and every real vendor adapter.

## Layout

The shape in `.claude/COMMON.md` is built; add modules under `src/modules/<name>/`.

- `src/container.ts` is the only composition root. It builds the logger, the kit error reporter
  (Sentry through the kit's port, never imported here), the token verifier, the database, the queue,
  the object store, the vector store, the processed store, the embedder, parser and OCR ports, and
  the consumer. `src/testing.ts` builds the same container from in-memory doubles and virtual time.
- The real SQS and S3 adapters are built only when `QUEUE_URL` and `STORAGE_BUCKET` are set; the
  kit's memory adapters otherwise, which `src/env.ts` allows only when `ENVIRONMENT=local`. The
  vector store is memory only: turbopuffer's adapter is blocked on hub issue 48.
- `src/ports/` holds the embedder, parser and OCR ports (ADR 0010, kept here by ADR 0016), each with
  a behaviour suite; `src/adapters/memory/` has the fakes. No real adapter exists.
- All database access goes through `container.withOrganization(organizationId, fn)`, the db
  library's tenant-scoped helper. Statements are the db library's `PLAYBOOK_STATEMENTS` strings;
  `statementOf` in `src/adapters/postgres/processed-store.ts` binds their `$n` placeholders.
- `src/messages.ts` is the registry of the two contract messages. `src/consumer.ts` wires the kit's
  `createConsumer` (name `playbook.ingestion`) over the Postgres `ProcessedStore`; handlers go in
  `createHandlers`. `server.ts` starts the consumer; shutdown stops it (`stoppableWith`).
- Public routes mount on `publicRoutes` in `src/app.ts` under `/v1`, behind `authenticate`. Read the
  caller with `callerOf(c)`: the Organization comes from the verified token and nowhere else.
- Errors: `reportError` is the one seam; call `reportSafely`. Log errors with `describeError`.
- `openapi.json` is generated: `bun run openapi`; `verify` fails if it is stale.

## Rules for this service

- Every handler is idempotent: the processed store makes a message run once, but a crash between the
  effect and `complete` runs it again, so every step is a keyed upsert or a state check.
- A queue message type is published only after its handler exists. A message with no handler is
  loud, not silently lost: logged and reported at every delivery, hidden for the invalid delay
  (60 s), and dead-lettered after the queue's `maxReceiveCount`.
- An unhandled rejection or uncaught exception is fatal by design: it is reported, the consumer
  stops receiving, and the process exits 1 (`src/exit.ts`). Catch what a step can recover from.
- Hub issue 14: the 1 MiB global body limit (`MAX_REQUEST_BODY_BYTES`, `createBaseApp`) and Bun's
  `maxRequestBodySize` (`serveOptions`) block the 25 MiB upload until the upload route sets its own
  limit and `serve.ts` raises Bun's to match.
- Vector ids are deterministic (`<documentId>:<chunk>`) and each vector carries its job's epoch
  (db README, ADR 0016). Search drops results whose document is deleted or gone; that state check
  is the guarantee, the vector cleanup is not.
- Uploads are held whole in memory: `MAX_CONCURRENT_UPLOADS` bounds them per instance, and sizes and
  page counts come from the contract's constants (`env.ts` may lower them, never raise them).
- File content, extracted text and prompts are untrusted data. Never log or return them; no
  document text in an error message, a log field or a queue payload.
- Every call to a vendor port takes an `AbortSignal`. Every call has its own timeout and a bounded,
  jittered retry inside the adapter (`COMMON.md`); the caller cancels with the signal and retries
  nothing itself. `embed` takes at most `MAX_EMBED_TEXTS` texts; the caller splits.
- `ProcessedStore.purge` throws `ProcessedStorePurgeUnavailableError` until hub issue 53 lets the
  service list the Organizations to purge; `purgeScope` works per scope. Do not make `purge` a
  quiet partial.

## Env keys (`src/env.ts`, mirrored in `.env.example`)

`ENVIRONMENT` (required, no default), `PORT`, `LOG_LEVEL`, `READINESS_TIMEOUT_MS`,
`SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `MAX_REQUEST_BODY_BYTES`, `REGION`, `SENTRY_DSN`,
`GIT_SHA`, `DATABASE_URL`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AWS_REGION`,
`QUEUE_URL`, `QUEUE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `MAX_UPLOAD_BYTES`,
`MAX_PAGES_PER_DOCUMENT`, `MAX_CONCURRENT_UPLOADS`, `CONSUMER_CONCURRENCY`,
`CONSUMER_STOP_DEADLINE_MS`. Outside `local`, `REGION`, `SENTRY_DSN`, `DATABASE_URL`, the `AUTH_*`
keys, `AWS_REGION`, `QUEUE_URL` and `STORAGE_BUCKET` are required. Add a key in both files.

## Hot paths

Each has a benchmark in `bench/` with a budget; a change to one states its complexity in the PR.

- **The per-request middleware stack** (`createBaseApp`) and `/healthz`: O(1) per request.
- **The ingestion claim** (`createPlaybookConsumer`: receive, claim, handle, complete, acknowledge),
  O(1) per message in the store: `bench/consumer.bench.test.ts`. The Postgres store adds one
  statement per step; only its integration suite sees that.
- **Playbook search** (not built): the Copilot searches inside a budget of about 1.5 s on a live
  call (ADR 0010), so one embedding call plus one vector query must stay O(topK) and never scan an
  Organization's documents. Add its benchmark with the first search function and name it here.

A benchmark times `measure(operation)`: a warm-up, then several batches, gated on the fastest, so a
noisy runner cannot fail it but a real regression (every batch slower) does. Budget is about 5x the
typical best batch, written in the file.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:playbook`.
