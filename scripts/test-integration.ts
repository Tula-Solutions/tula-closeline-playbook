// Runs the integration suites (`*.integration.ts`) against the compose Postgres: applies the
// database library's migrations as the owner role, then runs every suite with the service login.
// Start Postgres first: `docker compose up -d --wait` (POSTGRES_PORT moves the published port).
import { integrationUrls } from '../src/integration-support'

const FIVE_MINUTES_MS = 300_000

const urls = integrationUrls()
const env = { ...process.env, DATABASE_URL: urls.service, DATABASE_URL_OWNER: urls.owner }

const migrate = Bun.spawnSync(['bun', 'node_modules/tula-closeline-db/scripts/migrate.ts'], {
  env: { ...env, DATABASE_URL: urls.owner },
  stdout: 'inherit',
  stderr: 'inherit',
  timeout: FIVE_MINUTES_MS,
})
if (migrate.exitCode !== 0) {
  process.stderr.write(
    'test:integration: migrations failed; is `docker compose up -d --wait` running?\n'
  )
  process.exit(migrate.exitCode ?? 1)
}

const files = [...new Bun.Glob('src/**/*.integration.ts').scanSync('.')].sort().map((f) => `./${f}`)
const run = Bun.spawnSync(['bun', 'test', '--timeout', '30000', ...files], {
  env,
  stdout: 'inherit',
  stderr: 'inherit',
  timeout: FIVE_MINUTES_MS,
})
process.exit(run.exitCode ?? 1)
