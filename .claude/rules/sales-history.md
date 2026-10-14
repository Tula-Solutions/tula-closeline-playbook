---
paths:
  - "src/modules/deal/**"
  - "src/modules/rights/**"
  - "src/modules/deal-import/**"
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
- Remove-all deletes import files first, then erases and purges up to 5 imports per request
  (`DEAL_IMPORT_ERASE_BATCH`, `DEAL_IMPORT_PURGE_BATCH`), before it erases Deals.
- A blank record in the middle of the file is reported as a rejected `wrong_column_count` row, since
  the report must be contiguous; trailing blank records are dropped.
- A CSV whose delete failed after its import ended stays until the orphan sweep next visits the
  Organization. That sweep is scheduled by upload attempts, so it can wait for a later upload; remove-all
  also deletes it.
- A claim takes at most one import per Organization per pass, so one Organization cannot hold every
  slot of the shared pool. A per-Organization cap on queued imports is a contract/db follow-up.
- A deal id is the customer's text and may begin with `=`, `+`, `-` or `@`: any export or UI that
  shows it must escape it (spreadsheet formula injection).
