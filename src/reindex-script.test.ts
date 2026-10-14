import { describe, expect, test } from 'bun:test'

const ORGANIZATION = 'org_0123456789abcdef0123456789abcdef'

/** Runs the re-index script with `env` only; a database nobody listens on, so any connection attempt would fail differently. */
function run(env: Record<string, string>) {
  return Bun.spawnSync(['bun', 'scripts/reindex-documents.ts', '--organization', ORGANIZATION], {
    env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  })
}

describe('the local-dev re-index script', () => {
  test.each([
    ['prod', { ENVIRONMENT: 'prod' }],
    ['staging', { ENVIRONMENT: 'staging' }],
    ['unset', {}],
    ['not an environment', { ENVIRONMENT: 'banana' }],
  ])(
    'on a loopback database it still refuses when ENVIRONMENT is %s, before connecting',
    (_label, env) => {
      const result = run(env)

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('ENVIRONMENT must be local')
    }
  )

  test('a loopback database carrying a query parameter is refused', () => {
    const result = run({
      ENVIRONMENT: 'local',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db?host=prod.example',
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('no query parameters')
  })

  test('with ENVIRONMENT=local it gets past the guards and only then tries the database', () => {
    const result = run({ ENVIRONMENT: 'local' })

    expect(result.stderr.toString()).not.toContain('ENVIRONMENT must be local')
  })
})
