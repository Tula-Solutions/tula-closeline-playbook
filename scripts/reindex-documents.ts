// Local development only: re-queues the ingestion of one Organization's ready documents so their
// chunk vectors are written again with the search snippet (`v: 2`, hub issue 98). Vector ids are
// deterministic, so the rewrite overwrites the old vectors at the same epoch; nothing is deleted.
// A document is not in search while its job runs. Bounded and paged, and never on a request path.
// Production re-indexing is a separate ticket (hub issue 99).
//
//   DATABASE_URL=postgres://...@127.0.0.1:5440/closeline \
//     bun scripts/reindex-documents.ts --organization org_<hex> [--page 100] [--limit 1000]
import { sql } from 'drizzle-orm'
import { organizationIdSchema } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'

const DEFAULT_PAGE = 100
const MAX_PAGE = 500
const DEFAULT_LIMIT = 1_000

/** The value following `--name`, or undefined. */
function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const url = process.env.DATABASE_URL
// No query string: a `?host=` parameter could send the connection somewhere the host name does not say.
if (url !== undefined && new URL(url).search !== '') {
  process.stderr.write('reindex-documents: DATABASE_URL must have no query parameters\n')
  process.exit(1)
}
if (
  url === undefined ||
  !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname)
) {
  process.stderr.write('reindex-documents: DATABASE_URL must be set and point at a loopback host\n')
  process.exit(1)
}
const organization = organizationIdSchema.safeParse(option('organization'))
if (!organization.success) {
  process.stderr.write('reindex-documents: --organization org_<hex> is required\n')
  process.exit(1)
}
const page = Math.min(Math.max(Number(option('page') ?? DEFAULT_PAGE) || DEFAULT_PAGE, 1), MAX_PAGE)
const limit = Math.max(Number(option('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1)

const service = createDb(url)
let after = ''
let queued = 0
while (queued < limit) {
  const size = Math.min(page, limit - queued)
  const result = await withOrganization(service.db, organization.data, (tx) =>
    tx.execute<{ id: string }>(sql`
      with picked as (
        select id, epoch from playbook.documents
        where organization_id = ${organization.data} and state = 'ready' and id > ${after}
          and not exists (
            select 1 from playbook.ingestion_jobs j
            where j.organization_id = ${organization.data} and j.document_id = documents.id
              and j.state in ('queued', 'running'))
        order by id limit ${size}),
      d as (
        update playbook.documents x
        set state = 'uploaded', updated_at = clock_timestamp()
        from picked
        where x.organization_id = ${organization.data} and x.id = picked.id and x.state = 'ready'
        returning x.id, x.epoch),
      queued as (
        insert into playbook.ingestion_jobs (id, organization_id, document_id, epoch, next_attempt_at)
        select 'job_' || replace(gen_random_uuid()::text, '-', ''), ${organization.data}, id, epoch,
          clock_timestamp()
        from d)
      select id from picked order by id`)
  )
  const ids = (result.rows as { id: string }[]).map((row) => row.id)
  if (ids.length === 0) {
    break
  }
  queued += ids.length
  after = ids[ids.length - 1] ?? after
}
await service.close()
process.stdout.write(`reindex-documents: queued ${queued} document(s)\n`)
