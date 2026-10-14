import { sql } from 'drizzle-orm'

/** The part of a scoped transaction the re-index statement needs. */
type Transaction = { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }

/**
 * Puts the next page of an Organization's `ready` documents (ids after `after`, at most `size`) back
 * in the ingestion queue at the same epoch, for the local-dev re-index script. The db library's
 * `DOCUMENT_REQUEUE` only acts on a `failed` document, so this is the one statement the playbook
 * writes itself: it flips `ready` to `uploaded` and adds one job, which the normal claim then runs.
 * A document with a queued or running job is skipped. Returns the ids it queued, in order.
 */
export async function requeueReadyDocuments(
  tx: Transaction,
  organizationId: string,
  after: string,
  size: number
): Promise<string[]> {
  const result = await tx.execute(sql`
    with picked as (
      select id, epoch from playbook.documents
      where organization_id = ${organizationId} and state = 'ready' and id > ${after}
        and not exists (
          select 1 from playbook.ingestion_jobs j
          where j.organization_id = ${organizationId} and j.document_id = documents.id
            and j.state in ('queued', 'running'))
      order by id limit ${size}),
    d as (
      update playbook.documents x
      set state = 'uploaded', updated_at = clock_timestamp()
      from picked
      where x.organization_id = ${organizationId} and x.id = picked.id and x.state = 'ready'
      returning x.id, x.epoch),
    queued as (
      insert into playbook.ingestion_jobs (id, organization_id, document_id, epoch, next_attempt_at)
      select 'job_' || replace(gen_random_uuid()::text, '-', ''), ${organizationId}, id, epoch,
        clock_timestamp()
      from d)
    select id from picked order by id`)
  return (result.rows as { id: string }[]).map((row) => row.id)
}
