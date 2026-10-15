// Operator script: gives one Call or Document whose purge used all its attempts a fresh set, so the
// purge sweep tries it again (hub issue 76, item 3). Find the item in the service's error log
// ("purges have given up and need a person", or the remove-all 503 line naming the stuck ids), fix
// what blocked it (an object store or vector store outage, a vendor copy), then run:
//
//   ENVIRONMENT=<env> DATABASE_URL=postgres://...closeline_playbook@host/closeline \
//     bun scripts/reset-spent-purge.ts --organization org_<hex> (--call call_<hex> | --document doc_<hex>) \
//     [--confirm <env> --confirm-host <host>]
//
// What is guarded, exactly: the playbook schema keeps no marker of which environment a database
// belongs to, so the script cannot check that itself. With ENVIRONMENT=local the database host must
// be a loopback address. Outside local you must pass `--confirm <env>` naming the same environment as
// ENVIRONMENT and `--confirm-host <host>` equal to the host in DATABASE_URL, so the command line
// states which database is written to. That catches a typo or a stale URL, not a person who types
// the right words for the wrong database. DATABASE_URL may carry no query parameters.
import { callIdSchema, documentIdSchema, organizationIdSchema } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { environmentSchema } from 'tula-closeline-kit'
import { statementOf } from '../src/adapters/postgres/processed-store'
import { resetSpentPurge } from '../src/modules/maintenance/reset-purge'

/** The value following `--name`, or undefined. */
function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

/** Prints the message and ends the process with a failure. */
function refuse(message: string): never {
  process.stderr.write(`reset-spent-purge: ${message}\n`)
  process.exit(1)
}

const environment = environmentSchema.safeParse(process.env.ENVIRONMENT)
if (!environment.success) {
  refuse('ENVIRONMENT must be set to local, dev, staging or prod')
}
if (environment.data !== 'local' && option('confirm') !== environment.data) {
  refuse(`ENVIRONMENT is ${environment.data}: pass --confirm ${environment.data} to reset there`)
}
const url = process.env.DATABASE_URL
if (url === undefined) {
  refuse('DATABASE_URL must be set')
}
if (environment.data !== 'local' && option('confirm-host') !== new URL(url).hostname) {
  refuse(
    `outside local, pass --confirm-host ${new URL(url).hostname} (the host in DATABASE_URL) to reset there`
  )
}
// No query string: a `?host=` parameter could send the connection somewhere the host name does not say.
if (new URL(url).search !== '') {
  refuse('DATABASE_URL must have no query parameters')
}
if (
  environment.data === 'local' &&
  !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname)
) {
  refuse('with ENVIRONMENT=local, DATABASE_URL must point at a loopback host')
}
const organization = organizationIdSchema.safeParse(option('organization'))
if (!organization.success) {
  refuse('--organization org_<hex> is required')
}
const callId = option('call')
const documentId = option('document')
if ((callId === undefined) === (documentId === undefined)) {
  refuse('give exactly one of --call call_<hex> or --document doc_<hex>')
}
const target =
  callId !== undefined ? callIdSchema.safeParse(callId) : documentIdSchema.safeParse(documentId)
if (!target.success) {
  refuse('the item id is not a valid id')
}

const service = createDb(url)
try {
  const reset = await withOrganization(service.db, organization.data, async (tx) =>
    resetSpentPurge(
      async (text, params) => {
        const result = await tx.execute(statementOf(text, params))
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 }
      },
      organization.data,
      { kind: callId !== undefined ? 'call' : 'document', id: target.data }
    )
  )
  process.stdout.write(
    reset
      ? `reset-spent-purge: ${target.data} has fresh purge attempts; the purge sweep will retry it\n`
      : `reset-spent-purge: ${target.data} is not a deleted item with a spent purge; nothing changed\n`
  )
} finally {
  await service.close()
}
