# tula-closeline-playbook

Closeline playbook service: ingestion, search and fine-tuning of an Organization's sales knowledge

Part of Closeline. The hub repo [`tula-closeline`](https://github.com/Tula-Solutions/tula-closeline)
holds the glossary, decision records, plans, issues and the shared workflow setup.

## Getting started

```bash
# Once per machine, if you have no SSH key on GitHub: fetch the private tula-closeline-*
# libraries over https with your gh login.
gh auth setup-git
git config --global url."https://github.com/Tula-Solutions/".insteadOf "ssh://git@github.com/Tula-Solutions/"

bun install
bun run verify
```

Standards: `AGENTS.md` (this repo) and `.claude/COMMON.md` (shared).

## Deal imports

An Owner or Admin uploads a CSV of past Deals (`deal_id,outcome,closed_at,amount,currency` and an
optional `name`; up to 10 MB and 50,000 rows) to `POST /v1/playbook/deal-imports`. The answer is
202; a background job applies it in batches of 500 rows and keeps a row-by-row report, read at
`GET /v1/playbook/deal-imports/{id}` and `/rows`. Bad rows are reported, never dropped.

| Key | Meaning |
| --- | --- |
| `IMPORTS_ENABLED` | run the import job (default true); independent of `WORKERS_ENABLED` |
| `MAX_DEALS_PER_ORGANIZATION` | most Deals one Organization may hold (default 20,000) |

The job shares `INGESTION_CONCURRENCY` with the document jobs, and takes at most one import per
Organization per pass. The whole CSV is held in memory while it runs (at most 10 MB): there is no
streaming reader yet.

Sizing (memory per instance, from the reviewer's measurements):

- An upload holds about 30 MB while it is received, for each upload in flight, up to
  `MAX_CONCURRENT_UPLOADS` (shared with document uploads).
- A running import job holds about 100 MB (the file, its text and 50,000 parsed records), so about
  200 MB at the default `INGESTION_CONCURRENCY` of 2 and about 1.6 GB at 16.

### Erasing imports (remove-all)

Remove-all takes at most 5 imports to their end per request and answers 503 until none remain.
It first finishes imports an earlier request erased but did not finish (the CSV removed, that
recorded, the report purged in steps), then erases more, so a crash or a storage failure at any step
is finished by the next call and never strands an import.

## Calls

An Owner or Admin uploads a Transcript (`.txt`, `.vtt`, `.srt` or `.json`, up to 5 MB) with the deal id
and the Rep's speaker label to `POST /v1/playbook/calls`, once the Organization has confirmed the
rights wording (its version and text come from the contract; `GET /v1/playbook/rights-confirmation` returns
the current text). A background job parses it into turns, builds one Moment per Prospect turn (a window
of recent turns, embedded by role and never by speaker name) and writes the Moments' vectors tagged with
the Deal's Outcome. List and read: `GET /v1/playbook/calls` and `/{id}`. No search route exists yet.
Recordings are not accepted yet. Changing the Rep (`PUT /v1/playbook/calls/{id}/rep`) rebuilds the Moments;
`DELETE /v1/playbook/calls/{id}` and `POST .../restore` delete and restore a Call within 30 days. The
Outcome re-tag job patches the Moment vectors' tags when a Deal's Outcome changes (no re-embedding), found by
discovery rather than by a message; the vector adapter must support patch-by-id (`setAttributes`). The Call job shares `INGESTION_CONCURRENCY`, takes one job per
Organization per pass and is gated by `WORKERS_ENABLED`; remove-all erases Calls before Deals.
