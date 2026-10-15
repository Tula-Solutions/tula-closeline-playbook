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
  delete is left to its message. A pass stops after 3 consecutive failed cleanups (a success resets
  the count); a failing document is reported once per 30 min window (in-process map, 1000 entries,
  deduplication only) and repeats log a warning with ids. A delete message whose cleanup waits on a lease is
  acknowledged (the kit cannot retry without an error report) and that sweep finishes it.
- A message for a removed Organization (no documents, settings or usage left) is acknowledged and
  not recorded (`withoutRemovedOrganizations`), so the remove-all can reach `removed`.
- Two switches: `WORKERS_ENABLED` is the job loop only (refused outside `local` while the ports are
  fakes); `SWEEPS_ENABLED` (default true) runs the purge, cleanup_pending, housekeeping and orphan
  sweeps and never depends on the job loop.
- Lowering a limit (`CHUNK_MAX_CHARS`, `MAX_CHUNKS_PER_DOCUMENT`, `MAX_TEXT_CHARS_PER_DOCUMENT`) can
  fail documents in flight: a stored artifact the new schema refuses is cut again from the pages
  when no chunk of that epoch is embedded yet, and otherwise ends the document `processing_failed`.
- Known gap: a job artefact write that lands after its document's purge leaves an object with no
  document row and no hint (the lease normally prevents it).
- Parser (`src/adapters/parser/`, hub issue 59). Never parse in the main thread: `createDocumentParser`
  runs each document in a fresh Bun `Worker` (`worker.ts`), ended on the hard time limit, the abort
  signal, or when `process.memoryUsage.rss()` has grown past `PARSER_MEMORY_LIMIT_BYTES` since the
  parse began (polled every 50 ms; Bun 1.4.2 ignores Worker `resourceLimits`, so this is a bound
  with a polling gap, backed by the size limits below; a killed Worker's memory may stay resident
  for a while). When the bound trips while another parse is live, the parse ends with
  `ParserOverloaded` (retried by the job, not failed; the parses of one episode are judged alike
  for two polls), and only a file that trips it alone is `processing_failed`. After such an
  event parses on the instance run one at a time for `EXCLUSIVE_LANE_MS` (30 s, extended by another
  event; in-process state only, a restart starts with the lane open), so a retry runs alone: a
  healthy file finishes and a runaway trips the limit by itself and fails for good, at its next
  attempt. Waiting for the lane does not count against the parser's own time limit (it starts with
  the worker) but does count against the job's call timeout, which is retried; the wait honours the
  abort signal (checked on every pass) and the job's heartbeat keeps running meanwhile. The wait
  is capped at `LANE_WAIT_MAX_MS` (15 s) or 80% of the margin between the parser limit and the job
  timeout (`laneWaitCap`), whichever is less, and past it the parse ends `ParserOverloaded`, so a
  hostile file that waited can still reach the parser's own verdict before the job's timeout. A throw while handing the document
  to the worker is `ParserTransferFailed`, also retried. The Worker's
  reply is checked with a Zod schema against the limits before use. Hang, crash, runaway and nonsense replies are `ParseError('processing_failed')`,
  never retried (the file is the cause). No error message or log holds file content.
  - Formats: PDF through `unpdf` (pdf.js, no native canvas): page count checked before any page,
    password request is `password_protected`, a page without a text layer is empty with
    `needsOcr`. DOCX reads only `word/document.xml`; PPTX only the slide parts, in the order of
    `p:sldId`, with the slide count checked before inflating. TXT and MD: UTF-8, BOM dropped,
    UTF-16 or NUL is `unreadable`, more than 1% invalid bytes is `unreadable`, pages of 20 000
    characters. A DOCX page ends at a page break, a rendered break or `pageBreakBefore`.
  - Archives (`zip.ts`): from the central directory, before inflating: at most 5 000 entries, 32 MiB
    per entry, 128 MiB in total, 150 times inflation for an entry over 1 MiB (all
    `processing_failed`); names with `..`, a root, a drive, a backslash or NUL, duplicates, zip64
    and multi-part archives are `unreadable`; inflation stops at the declared size
    (`maxOutputLength`) and the CRC is checked; an encrypted entry or a compound-file container
    (an Office file with a password) is `password_protected`. Nested archives are never opened.
  - XML (`xml.ts`): a DOCTYPE or any `<!` declaration other than a comment or CDATA is refused, so
    no entity is defined, resolved or fetched; only the five predefined and numeric references
    decode; depth at most 256 with an explicit stack. Macros and embedded objects are never read.
  - Limits that are settings: `MAX_PAGES_PER_DOCUMENT`, `MAX_TEXT_CHARS_PER_DOCUMENT`,
    `INGESTION_PARSE_TIMEOUT_MS`, `PARSER_MEMORY_LIMIT_BYTES`. The rest are constants in the
    parser files. A change to any parser limit needs a hostile-input test in `office.test.ts`,
    `pdf.test.ts` or `text.test.ts` and a budget check in `bench/parser.bench.test.ts`.
  - Fixtures are built in code (`test-support.ts`: `buildPdf`, `buildZip`, `buildDocx`, `buildPptx`).
- Known gaps (parser): a PDF with some text pages and some scanned pages ends `ready` with only
  the text pages until real OCR lands; PDFs that rely on predefined CJK CMaps may extract little
  text because no CMap source is configured; a hostile page that spins the CPU is stopped only by
  the host's time limit.
- Job slots: one pool per instance (`INGESTION_CONCURRENCY`); one Organization holds at most
  `INGESTION_ORGANIZATION_CONCURRENCY` of it (jobs, imports and re-tags together; default pool minus
  one, at least 1). The count is in process memory and per instance, so it is a fairness bound, not
  a quota: a claim at the share is skipped and made on a later pass.
- Known gap (parser memory): measured with the stand-in runaway Worker, the 50 ms poll lags a fast
  allocator by hundreds of megabytes (a kill at about 765 MB of growth for a 256 MB limit), and a
  killed Worker's memory stays resident. With the default 1 GiB limit the process can reach roughly
  1.5 to 2 GiB above its baseline: size the container for that.
