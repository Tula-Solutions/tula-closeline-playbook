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

The job shares `INGESTION_CONCURRENCY` with the document jobs. The whole CSV is held in memory
while it runs (at most 10 MB): there is no streaming reader yet.
