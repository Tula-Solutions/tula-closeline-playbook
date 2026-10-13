---
paths:
  - "src/modules/ingestion/**"
  - "src/modules/maintenance/**"
  - "src/workers/**"
---

# The ingestion pipeline (hub issue 14, round B)

- The job (`runJob`) has four steps, each recorded with `INGESTION_JOB_ADVANCE`, so a retry resumes:
  parse (original read, parser, OCR in batches of 50; `page_count` recorded, pages written to
  `pages-<epoch>.json`), chunk (`chunks-<epoch>.json`, which holds the chunk text because the kit's
  vector attributes cap at 512 characters; search reads text from it by chunk number), embed
  (batches of `MAX_EMBED_TEXTS`, `chunks_done` recorded per batch), index (older-epoch vectors and
  the pages file go, then `INGESTION_JOB_COMPLETE`). Failures end `failed` with a contract reason;
  a transient error retries with jittered backoff until `INGESTION_MAX_ATTEMPTS` (8: every
  shutdown release and rolling deploy spends a claim attempt).
- A heartbeat renews the lease every `INGESTION_HEARTBEAT_MS` and once more before each vector
  write. A missing row on any renew, advance or complete, or no renewal for lease minus heartbeat,
  is a lost claim: in-flight calls are cancelled and nothing more is written. A vector write that
  is interrupted (timeout, shutdown) while the store has not answered is uncertain: the job stays
  running until its lease lapses and is never released. Shutdown otherwise releases the job
  (`INGESTION_JOB_RETRY`, delay 0) at its recorded step. Jobs run in one pool across
  Organizations (`INGESTION_CONCURRENCY`); chunking yields every 65 536 characters.
- Vectors: id `<documentId>:<epoch>:<chunk>`, attributes `document_id`, `epoch`, `chunk`, `page`;
  the stores are scoped to the Organization by their ports. Chunks target `CHUNK_TARGET_CHARS`
  (1000, about 250 tokens), at most `CHUNK_MAX_CHARS` (1600), overlap only inside an over-long
  paragraph; a document over `MAX_CHUNKS_PER_DOCUMENT` or `MAX_TEXT_CHARS_PER_DOCUMENT` fails
  `processing_failed`. Filters are equality only, so a live cleanup deletes per epoch (newest 64);
  a purge deletes by `document_id` alone, which covers every epoch.
- Workers find Organizations with the one unscoped call, `ORGANIZATIONS_WITH_WORK` (`discover`,
  alone in its transaction); everything else runs in the Organization scope. Sweeps: `cleanup` and
  `purge` every `SWEEP_INTERVAL_MS`, `housekeeping` (consumed and idempotency purges, spent purges
  logged for a person and never claimed, orphan objects) every `HOUSEKEEPING_INTERVAL_MS`. Orphan
  rule: delete an object under `documents/doc_<id>/` only if the id has no row and the object is
  older than 24 h (`ORPHAN_OBJECT_MIN_AGE_MS`, the db's rule, not a setting). Orphans have the `orphan_sweep` work kind (an Organization
  is named 25 h after its oldest unswept upload attempt): `visitOrphanSweep` sweeps, then records
  it with `ORPHAN_SWEEP_DONE` using the time the sweep started (not when done is called), under a
  1 s `lock_timeout`; a timeout is tried again next tick, unreported, and a listing cut short by
  `ORPHAN_MAX_PAGES` is not marked. Keys are purged at `IDEMPOTENCY_PURGE_AGE_MS` (26 h). Upload
  transactions insert their idempotency key before `QUOTA_LOCK` (the db's lock-order rule).
  An upload that may write an object first commits an attempt record (route
  `documents.upload_attempt`, random key, no response; one short extra transaction and one row per
  such upload, purged at 26 h) so the orphan sweep can find an object whose answer was lost; if the
  record fails, the upload fails before anything is stored.
  `cleanup_pending` lists exactly the pending cleanups (`DOCUMENT_LIST_PENDING_CLEANUP`, keyset
  `(deleted_at, id)`, at most 5 pages of 100 a tick) and keeps a five-minute floor so a fresh
  delete is left to its message. A delete message whose cleanup waits on a lease is
  acknowledged (the kit cannot retry without an error report) and that sweep finishes it.
- A message for a removed Organization (no documents, settings or usage left) is acknowledged and
  not recorded (`withoutRemovedOrganizations`), so the remove-all can reach `removed`.
- Two switches: `WORKERS_ENABLED` is the job loop only (refused outside `local` while the ports are
  fakes); `SWEEPS_ENABLED` (default true) runs the purge, cleanup_pending, housekeeping and orphan
  sweeps and never depends on the job loop.
- Lowering a limit (`CHUNK_MAX_CHARS`, `MAX_CHUNKS_PER_DOCUMENT`, `MAX_TEXT_CHARS_PER_DOCUMENT`) can
  fail documents in flight: a stored artifact the new schema refuses is cut again from the pages
  when no chunk of that epoch is embedded yet, and otherwise ends the document `processing_failed`.
