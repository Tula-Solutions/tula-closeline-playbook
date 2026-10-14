---
paths:
  - "src/modules/deal/**"
  - "src/modules/rights/**"
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
