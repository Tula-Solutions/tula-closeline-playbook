/** The two logins the integration suites use. */
export type IntegrationUrls = {
  /** The `closeline_playbook` login the service itself uses. */
  service: string
  /** The `closeline_owner` login, which owns the tables and can read the no-access ones. */
  owner: string
}

/**
 * The connection strings of the compose Postgres, or `DATABASE_URL` and `DATABASE_URL_OWNER` when
 * both are set (the `test:integration` script sets them). Only a loopback host is accepted, since
 * the suites write rows; set `ALLOW_NON_LOCAL_TEST_DATABASE=1` for a disposable remote one.
 */
export function integrationUrls(): IntegrationUrls {
  const port = process.env.POSTGRES_PORT || '5432'
  const at = (login: string) =>
    `postgres://closeline_${login}:closeline_${login}_local@127.0.0.1:${port}/closeline`
  const service = process.env.DATABASE_URL
  const owner = process.env.DATABASE_URL_OWNER
  if ((service === undefined) !== (owner === undefined)) {
    throw new Error('Set both DATABASE_URL and DATABASE_URL_OWNER, or neither')
  }
  const urls = { service: service ?? at('playbook'), owner: owner ?? at('owner') }
  for (const url of [urls.service, urls.owner]) {
    const host = new URL(url).hostname
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      if (process.env.ALLOW_NON_LOCAL_TEST_DATABASE !== '1') {
        throw new Error(
          `Refusing to run integration tests against host "${host}": it is not loopback`
        )
      }
    }
  }
  return urls
}
