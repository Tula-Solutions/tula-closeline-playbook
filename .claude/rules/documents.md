---
paths:
  - "src/modules/document/**"
---

# Document uploads and lists

- The default `UPLOAD_BODY_TIMEOUT_MS` of 60 s assumes at least about 3.5 Mbit/s up for a 25 MiB
  file (25 MiB in 60 s); slower links need a larger value, and it is left at 60 s deliberately.
- Measured on Bun 1.4.2 against a real server: a 25 MiB upload peaks at about 26 MiB of buffers and
  25 to 50 MiB of resident memory once warm (up to about 100 MiB on the first), so plan 4 times the
  file per upload: 100 MiB, 400 MiB at the default bound of 4.
- A list is one call to `DOCUMENT_LIST_FILTERED` (db v0.12.0): any state filter, every column a read
  returns on each row (`updated_at`, `page_count`), so a listed document is never read again.
  `pageCount` is the row's `page_count`, null until the job records it with `INGESTION_JOB_ADVANCE`.
