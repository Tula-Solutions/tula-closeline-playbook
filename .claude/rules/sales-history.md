---
paths:
  - "src/modules/deal/**"
  - "src/modules/rights/**"
  - "src/modules/deal-import/**"
  - "src/modules/call/**"
---

# Sales history: Deals and the rights confirmation (ADR 0018, hub issue 69)

- Owner and Admin only (`SALES_HISTORY_READ_ROLES`), checked in the route middleware and again in the
  service. A second Organization gets `deal.not_found`, never a 403 that confirms the id exists.
- The customer's deal id, a Deal name and any CSV cell are never logged, never in a path and never
  in an error. Lookup takes the id in a POST body for that reason. Log record ids and counts only.
- A list uses one of three statements by filter (`DEAL_LIST`, `_BY_OUTCOME`, `_BY_IMPORT_FLAG`);
  both filters at once is `request.invalid`. Build the next cursor from the row's `cursor_at` text,
  never from a `Date` (microseconds). SQLSTATE 22007 from a cursor is `request.invalid`.
- Setting an Outcome publishes `playbook.deal_outcome_changed` after the commit and only when the
  statement says `changed`. A failed publish keeps the change and logs ids; the later re-tag recovers
  from the Deal's `outcome_seq`. The consumer acknowledges the message for now.
- Rights: only `RIGHTS_WORDING_VERSION` can be confirmed (else `rights.version_outdated`); who and
  when come from the token and the database clock. A repeat keeps the first record.
- Remove-all erases Deals with `DEAL_ERASE_BATCH` in bounded batches and answers 503 until none remain.
- A Deal at the sequence ceiling (about 2 billion Outcome changes) makes `DEAL_SET_OUTCOME` fail
  with 23514 and the route answers an unclassified 500. Accepted: the contract (v0.8.0) has no code
  for it and it cannot be reached in practice. Do not invent one here.
- Any SQLSTATE class 22 from a list statement is `request.invalid` with the fixed message; the
  cursor text is never echoed or logged. Other database errors stay 500.

## Deal imports (`src/modules/deal-import/`)

- Upload order: role, upload gate, body cap, multipart, size then `.csv` type, header on the first
  8192 characters (`deal_import.header_invalid` with a closed `problem`, never a cell), SHA-256, then
  one transaction (key first, insert) around the object write. Nothing is stored on a refusal.
  The rights confirmation is not checked here: the contract's upload errors do not list it.
- The job is found by the `import_apply` discovery hint, not a message. It runs under the same
  `INGESTION_CONCURRENCY` pool as documents and is gated by `IMPORTS_ENABLED`.
- Each batch is 500 rows in one transaction: `lock_timeout`, then `QUOTA_LOCK`, then
  `DEAL_IMPORT_APPLY` (the statement requires the upload lock). Resume starts after `report_through`;
  never apply a row twice, never renumber. A lock wait is retried with jitter, not failed.
- Publish Outcome-changed messages only after the batch commits. A lost publish is recovered from
  `outcome_seq`, as for a single Deal.
- Failure reasons are the closed set `too_many_rows`, `unreadable`, `processing_failed`. Reports,
  logs and errors carry row numbers, counts and reasons only: no cell, deal id, name or amount.
- The CSV is held whole (at most 10 MB): the object store port and the contract's reader do not
  stream. Records are released as batches finish.
- Remove-all finishes erased-but-unpurged imports first (`DEAL_IMPORT_LIST_ERASED`: remove the CSV
  when `object_pending`, `DEAL_IMPORT_OBJECT_REMOVED`, `DEAL_IMPORT_PURGE_BATCH` to the end), then
  erases more with `DEAL_IMPORT_ERASE_BATCH` one at a time and finishes each at once, at most 5
  imports per request, before it erases Deals. Any failure leaves the import listed, so the repeat
  finishes it; never add a step that loses the id (db README, v0.16.0 section).
- A blank record in the middle of the file is reported as a rejected `wrong_column_count` row, since
  the report must be contiguous; trailing blank records are dropped.
- A CSV whose delete failed after its import ended stays until the orphan sweep next visits the
  Organization. That sweep is scheduled by upload attempts, so it can wait for a later upload; remove-all
  also deletes it.
- A claim takes at most one import per Organization per pass, so one Organization cannot hold every
  slot of the shared pool. A per-Organization cap on queued imports is a contract/db follow-up.
- A deal id is the customer's text and may begin with `=`, `+`, `-` or `@`: any export or UI that
  shows it must escape it (spreadsheet formula injection).

## Calls (`src/modules/call/`, hub issue 70, part one: Transcripts)

- Upload is Owner/Admin (`PLAYBOOK_WRITE_ROLES`); list and read are `SALES_HISTORY_READ_ROLES`. Order:
  role, upload gate, body cap (5 MB + 64 KB; a Recording body over it is `request.too_large`), multipart
  with only `file`, `dealId`, `rep`, size/type, `rep` must be a speaker label for a Transcript
  (`call.rep_invalid`), content check, SHA-256, then the key, `QUOTA_LOCK` and `CALL_INSERT` around the
  object write. A Recording upload is `call.unsupported_type` until the Recording ticket.
- `CALL_INSERT` answers five ways: `created` 201; `existing` 200 (a deleted Call is restored, a failed
  one with a transient reason is requeued, the new object is removed); `other_deal` is
  `call.content_in_other_deal` and says nothing of the other Call; `rights_required` is
  `rights.confirmation_required` with `wordingVersion`; `quota_exceeded`. A refused upload removes its new object
  when the rollback is certain, otherwise the orphan sweep (`calls/`) does.
- The job is found by the `call_jobs` hint, not a message, shares `INGESTION_CONCURRENCY`, and claims one job
  per Organization per pass. It parses (`transcript.ts`), records speakers, builds Moments (`moments.ts`),
  embeds and writes vectors, then `CALL_JOB_COMPLETE` in its own short transaction. Vector ids are
  deterministic (`momentVectorId`), so a retry overwrites. Moments are embedded by role, never by label.
- Every Moment vector carries `outcome` and `outcome_seq`, whatever the Deal's Outcome. Whether a Moment
  may be returned is decided at query time by `momentMayBeReturned` (`eligibility.ts`): the vector's tag
  says won AND Postgres says `inSearch`. The vector filter alone is never enough. No search route exists
  yet; nothing reads these vectors. The vector also carries `epoch` and `rep_seq`, and `momentMayBeReturned`
  requires them to equal the Call's (`CALL_GET` returns both), so a search ticket must read them with `inSearch`.
  The re-tag job rewrites the tags (below).
- Never log or return Transcript text, speaker labels, file names or the customer's deal id. Transcript
  text is untrusted data. A parse failure carries only a contract reason.
- Erase and purge order: `CALL_ERASE_BATCH` (remove the objects it names), `CALL_PURGE_CLAIM`, vector
  cleanup (`call_id` filter), objects under `calls/<id>/`, `CALL_PURGE_COMPLETE`, then `DEAL_ERASE_BATCH`
  (a Deal a Call names cannot be deleted; remove-all skips Deals while `no_calls` is false). Hints:
  `call_purge`, `call_cleanup`, `call_purge_spent`.

### Outcome re-tag, Rep change, delete and restore (part two)

- Re-tag (`retag.ts`) is found by discovery (`outcome_retag`: a Deal with `retag_through < outcome_seq`),
  never by a message. `playbook.deal_outcome_changed` and `playbook.call_rep_changed` only nudge. One task per
  Organization per pass, not counted in the pass's `ran`, so a Deal that cannot finish never keeps the loop
  awake. Per pass: at most `RETAG_DEALS_PER_PASS` Deals, batches of `RETAG_CALLS_PER_BATCH` Calls
  (`DEAL_RETAG_BATCH`), `RETAG_ROUNDS` rounds per Deal. Deals that cannot finish are paged past (`after` cursor,
  `RETAG_SCAN_LIMIT` examined per pass) so they never starve the Deals behind them; one re-tag per Organization
  runs at a time per instance.
- The re-tag patches tags, it never embeds: `VectorStore.setAttributes` (kit v0.9.0) merges `outcome` and
  `outcome_seq` into the existing Moment vectors, in batches of `MAX_UPSERT_BATCH`, under the vector store
  timeout, and never creates a vector; it returns the ids it did not find. The ids are rebuilt from the kept
  Transcript with `buildMoments` (no embedder call). The real vector adapter (hub issue 48) must implement
  `setAttributes` as patch-by-id (turbopuffer patches attributes without resending the vector).
- Convergence is patch, then verify: after the patch the Deal is re-read; if `outcome_seq` moved, the Call is
  patched again at the newer sequence (up to 4 attempts); only then `CALL_RETAGGED` records
  `tagged_outcome_seq`. If `setAttributes` reports missing ids for a Call (store data loss), the re-tag
  self-heals that one Call: it warns (Call id and count only), writes its Moments again like the parse job
  (same ids, current `rep_seq`, this pass's tag; the only embed in the re-tag path), then continues with
  the same re-read and record. A failed rebuild leaves the Call pending for the next pass. If the Call was
  deleted, restored or Rep-changed meanwhile, the vectors this pass wrote are removed, and anything
  written later is stopped at query time by `momentMayBeReturned`. Two re-taggers on one Deal are not
  serialised during the rebuild (the Deal lock is taken only in the closing transaction): the ids are
  deterministic and the writes idempotent, and each re-reads the Deal before recording.
- Lock order: the Deal row (`DEAL_RETAG_LOCK`), then Call rows. The lock and `DEAL_RETAG_DONE` run in one short
  transaction, with no external call inside. `DEAL_RETAG_DONE` refuses while a ready Call is stale, which is
  how a Call that finished mid-re-tag, or an Outcome that moved, brings another round.
- A Call that cannot be read (object gone, unparseable) is skipped and reported by id (`reportWorkerError`),
  and does not hold the Deals behind it.
- Rep change (`PUT /calls/{id}/rep`, Owner/Admin): `CALL_SET_REP` answers `changed`, `unchanged`, `invalid`
  (`call.rep_invalid`) or `not_changeable` (`call.rep_not_changeable`, 409: only `ready`, `awaiting_rep` or a
  Call `failed` with `rep_label_not_found` or `not_per_side` may change). `changed` bumps `rep_seq`, sets
  `processing` and queues a `rebuild` job, which is the process path again. After writing, the job deletes the
  vectors of earlier `rep_seq` of the epoch, one filter each (equality only). A late write from a cancelled
  job is stopped at query time by `momentMayBeReturned`. `playbook.call_rep_changed` only on `changed`.
- Delete (`DELETE /calls/{id}`) and restore (`POST /calls/{id}/restore`, Owner/Admin): delete is idempotent
  by end state and publishes `playbook.call_deleted` only when it changed the Call; the handler or the
  `call_cleanup` sweep removes the vectors after the job lease passes. Restore queues a `process` job at the
  raised epoch, so a cleanup still running removes only the older epochs. A deleted Call past its purge time,
  or one whose purge began, is `call.not_restorable` (410). Delete keeps the quota count; the purge returns it.
