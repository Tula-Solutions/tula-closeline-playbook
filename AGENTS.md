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

What exists: the skeleton (HTTP stack, token check, container, consumer loop, ports and fakes) and
the document routes (hub issue 14, round A), and the pipeline (round B): message handlers, the
ingestion job loop, the chunker, vector cleanup, and the purge, housekeeping and orphan sweeps.
What does not: every real vendor adapter (vector store, embedder, parser, OCR), and search.
**The pipeline is not deployable until plan steps 1.35 and 1.36 (hub issue 48 and the
embedder/OCR adapters) and the real parser land.** Until then `WORKERS_ENABLED=true` is refused at
boot outside `local` (it names the fake ports, `PIPELINE_FAKE_PORTS` in `src/env.ts`), and the
default there is false: an API-only instance whose uploads stay `uploaded`, nothing claiming them.

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
- `src/modules/document/` is the document module: `router.ts` (public, under `/v1`),
  `internal-router.ts` (behind the ADR 0013 secret, `/internal/...`), `service.ts` (every rule),
  `idempotency.ts` (the key table, core's pattern), `detect.ts` (content check), `schema.ts` (rows to
  contract documents, list cursor). Routes, roles, codes and descriptions come from the contract's
  `PLAYBOOK_ROUTES`. Unit tests run on `src/adapters/memory/playbook-database.ts`, a double that runs
  the db library's statements by their text; `document.integration.ts` runs the real ones. It is a required CI check that `bun run verify` does not
  run locally; run it with the compose Postgres up before relying on a change to a statement's use.
- `src/messages.ts` is the registry of the two contract messages. `src/consumer.ts` wires the kit's
  `createConsumer` (name `playbook.ingestion`) over the Postgres `ProcessedStore`; handlers go in
  `createHandlers`. `server.ts` starts the consumer and, after it listens, the workers
  (`WORKERS_ENABLED`); shutdown stops both (`stoppableWith`).
- `src/modules/ingestion/` is the pipeline (`job.ts`, `chunker.ts`, `cleanup.ts`, `handlers.ts`);
  `src/modules/maintenance/` the purge, cleanup-pending and housekeeping steps; `src/workers/` the
  loops (`ingestion.ts`, `sweeps.ts`, `discovery.ts`). Tests use `createPipelineHarness`.
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
- Body limits: every route has `MAX_REQUEST_BODY_BYTES` (1 MiB) except the upload, which has
  `MAX_UPLOAD_BYTES` plus 64 KiB of multipart envelope (`src/http/limits.ts`). Bun's
  `maxRequestBodySize` is one number per process, so `serveOptions` gives it the largest route
  limit and the app's own limits hold the others. The upload's limit checks the declared length
  only in middleware and caps the stream where the route reads it (`capBody`): nothing buffers an
  unauthenticated body.
- Both upload bounds (the instance's places and one Organization's share) are per instance and
  in memory. With `MAX_CONCURRENT_UPLOADS=1` the share is the whole gate. Two Organizations (or one
  with many accounts) can still hold every place by reconnecting each time a deadline passes, so a
  rate limit per user or source at the edge is required before production (hub issue 19, infra).
  The default `UPLOAD_BODY_TIMEOUT_MS` of 60 s assumes at least about 3.5 Mbit/s up for a 25 MiB
  file (25 MiB in 60 s); slower links need a larger value, and it is left at 60 s deliberately.
- The upload order (service.ts, `upload`): role, instance bound (`MAX_CONCURRENT_UPLOADS`, 503 with
  `Retry-After` when full: the contract has no code for it; one Organization may hold at most half
  the places, rounded up and at least one, else `rate.limited` 429 with `Retry-After`), body cap and
  a deadline on the body (`UPLOAD_BODY_TIMEOUT_MS`, default 60 s; a slower body is cut off with
  `server.timeout` 504 and gives its place back), multipart, `checkUploadFile` (with the instance's
  own `MAX_UPLOAD_BYTES`, before the file is copied out of the part),
  content check (a DOCX or PPTX is judged by the entry names in its ZIP central directory only),
  SHA-256, then one transaction (idempotency key, quota lock, duplicate by hash,
  quota, insert; it rolls back with `ObjectRequired` when it would insert before the file is
  stored), the object write under `documents/<documentId>/original.<type>`, the transaction again,
  and only then the publish. No publish inside a transaction. A crash before the commit leaves
  nothing a row names (the file is deleted only when the transaction certainly rolled back: an error
  raised while its work ran, or a serialization, deadlock or class 23 answer to the commit; any
  other error at or after the commit leaves the file and logs "unknown outcome"); after it the document is `uploaded` with a queued job, which the job loop
  finds without the message (`jobs_due`). A failed delete or restore publish is recovered by the
  `cleanup_pending` sweep. A publish failure never fails a request that has committed.
- The pipeline's rules (the job's steps and what each records, the heartbeat, lease and shutdown
  behaviour, vector ids, chunk sizes, the sweeps, the orphan rule, the removed-Organization guard)
  are in `.claude/rules/ingestion.md`; they load when you touch `src/modules/ingestion/`,
  `src/modules/maintenance/` or `src/workers/`.
- The remove-all route does bounded work (5 erase batches of 100, then the cleanup publishes eight
  at a time inside a 5 s budget; the rest is left to the `cleanup_pending` sweep) and answers 200
  only when nothing remains. Core must stop the Organization signing in and uploading before it
  calls: this service only detects an upload that lands late (a row left unerased) and answers 503. While documents remain it answers 503 `server.unavailable` with `Retry-After: 30` and
  stores no key; the caller repeats until 200. The key is required and stored with the final answer.
- Search drops results whose document is deleted or gone (ADR 0016); that state check is the
  guarantee, the vector cleanup is not.
- Uploads are held whole in memory: `MAX_CONCURRENT_UPLOADS` bounds them per instance, and sizes and
  page counts come from the contract's constants (`env.ts` may lower them, never raise them).
  Measured on Bun 1.4.2 against a real server: a 25 MiB upload peaks at about 26 MiB of buffers and
  25 to 50 MiB of resident memory once warm (up to about 100 MiB on the first), so plan 4 times the
  file per upload: 100 MiB, 400 MiB at the default bound of 4.
- A list is one call to `DOCUMENT_LIST_FILTERED` (db v0.12.0): any state filter, every column a read
  returns on each row (`updated_at`, `page_count`), so a listed document is never read again.
  `pageCount` is the row's `page_count`, null until the job records it with `INGESTION_JOB_ADVANCE`.
- File content, extracted text and prompts are untrusted data. Never log or return them; no
  document text in an error message, a log field or a queue payload.
- Every call to a vendor port takes an `AbortSignal`. Every call has its own timeout and a bounded,
  jittered retry inside the adapter (`COMMON.md`); the caller cancels with the signal and retries
  nothing itself. `embed` takes at most `MAX_EMBED_TEXTS` texts; the caller splits.
- `ProcessedStore.purge` finds Organizations through `consumed_purge` discovery; without `discover` it throws.

## Env keys (`src/env.ts`, mirrored in `.env.example`)

`ENVIRONMENT` (required, no default), `PORT`, `LOG_LEVEL`, `READINESS_TIMEOUT_MS`,
`SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `MAX_REQUEST_BODY_BYTES`, `REGION`, `SENTRY_DSN`,
`GIT_SHA`, `DATABASE_URL`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AWS_REGION`,
`QUEUE_URL`, `QUEUE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `MAX_UPLOAD_BYTES`,
`MAX_PAGES_PER_DOCUMENT`, `MAX_CONCURRENT_UPLOADS`, `UPLOAD_BODY_TIMEOUT_MS`, `MAX_DOCUMENTS_PER_ORGANIZATION`,
`MAX_BYTES_PER_ORGANIZATION`, `INTERNAL_API_TOKENS`, `CONSUMER_CONCURRENCY`,
`CONSUMER_STOP_DEADLINE_MS`, and the worker keys: `WORKERS_ENABLED` (local: true; elsewhere false), `WORKERS_STOP_DEADLINE_MS`,
`INGESTION_*` (`CONCURRENCY`, `LEASE_MS`, `HEARTBEAT_MS`, `IO_TIMEOUT_MS`, `PARSE_TIMEOUT_MS`,
`MAX_ATTEMPTS`, `RETRY_BASE_MS`, `POLL_INTERVAL_MS`), `CHUNK_TARGET_CHARS`, `CHUNK_MAX_CHARS`,
`CHUNK_OVERLAP_CHARS`, `MAX_CHUNKS_PER_DOCUMENT`, `MAX_TEXT_CHARS_PER_DOCUMENT`, `DISCOVERY_BATCH`,
`SWEEP_BATCH`, `HOUSEKEEPING_BATCH`, `SWEEP_INTERVAL_MS`, `HOUSEKEEPING_INTERVAL_MS`,
`PURGE_LEASE_MS`, `ORPHAN_*`. Outside `local`, `REGION`, `SENTRY_DSN`, `DATABASE_URL`, the `AUTH_*`
keys, `AWS_REGION`, `QUEUE_URL`, `STORAGE_BUCKET` and `INTERNAL_API_TOKENS` are required (the
public local secret is refused). Add a key in both files.

## Hot paths

Each has a benchmark in `bench/` with a budget; a change to one states its complexity in the PR.

- **The per-request middleware stack** (`createBaseApp`) and `/healthz`: O(1) per request.
- **The ingestion claim** (`createPlaybookConsumer`: receive, claim, handle, complete, acknowledge),
  O(1) per message in the store: `bench/consumer.bench.test.ts`. The Postgres store adds one
  statement per step, and the removed-Organization guard one more indexed read per consumed
  message (`ORGANIZATION_REMOVAL_STATUS`); a second bench times it over the database double.
- **Chunking** (`chunkPages`): O(total characters) time, O(input + output) memory, bounded by
  `MAX_CHUNKS_PER_DOCUMENT`: `bench/chunker.bench.test.ts`. **The claim loop** is O(`INGESTION_CONCURRENCY`)
  per Organization per pass plus O(Organizations with work) discovery, in pages of `DISCOVERY_BATCH`.
- **The upload** (`upload` in `src/modules/document/service.ts`): O(file size) for the file check,
  the content check and the SHA-256, with no copy of the file, plus one transaction of O(1) indexed
  statements (two when the file is new) and one object write: `bench/upload.bench.test.ts` times the
  CPU-bound part on a 25 MiB file. A list page is O(page size) reads; a filtered one is bounded by 6
  pages of 100. The remove-all route is bounded by 5 batches of 100.
- **Playbook search** (not built): the Copilot searches inside a budget of about 1.5 s on a live
  call (ADR 0010), so one embedding call plus one vector query must stay O(topK) and never scan an
  Organization's documents. Add its benchmark with the first search function and name it here.

A benchmark times `measure(operation)`: a warm-up, then several batches, gated on the fastest, so a
noisy runner cannot fail it but a real regression (every batch slower) does. Budget is about 5x the
typical best batch, written in the file.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:playbook`.
