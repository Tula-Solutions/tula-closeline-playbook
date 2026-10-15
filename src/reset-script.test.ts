import { describe, expect, test } from 'bun:test'

const ORGANIZATION = 'org_0123456789abcdef0123456789abcdef'
const CALL = 'call_0123456789abcdef0123456789abcdef'
const DOCUMENT = 'doc_0123456789abcdef0123456789abcdef'

/** Runs the reset script with `env` only and a database nobody listens on, so any connection attempt would fail differently. */
function run(env: Record<string, string>, args: string[]) {
  return Bun.spawnSync(['bun', 'scripts/reset-spent-purge.ts', ...args], {
    env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  })
}

const BASE = ['--organization', ORGANIZATION, '--call', CALL]

describe('the spent-purge reset script', () => {
  test.each([
    ['unset', {}],
    ['not an environment', { ENVIRONMENT: 'banana' }],
  ])('refuses when ENVIRONMENT is %s, before connecting', (_label, env) => {
    const result = run(env, BASE)

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('ENVIRONMENT must be set')
  })

  test.each(['prod', 'staging', 'dev'])(
    'outside local it refuses %s without a matching --confirm',
    (environment) => {
      const without = run({ ENVIRONMENT: environment }, BASE)
      const wrong = run({ ENVIRONMENT: environment }, [...BASE, '--confirm', 'local'])

      for (const result of [without, wrong]) {
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr.toString()).toContain(`--confirm ${environment}`)
      }
    }
  )

  test('with ENVIRONMENT=local a database that is not on loopback is refused', () => {
    const result = run(
      { ENVIRONMENT: 'local', DATABASE_URL: 'postgres://u:p@db.example/closeline' },
      BASE
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('loopback')
  })

  test('a database URL with a query parameter is refused', () => {
    const result = run(
      { ENVIRONMENT: 'local', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db?host=prod.example' },
      BASE
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('no query parameters')
  })

  test('exactly one of --call and --document is required', () => {
    const both = run({ ENVIRONMENT: 'local' }, [...BASE, '--document', DOCUMENT])
    const neither = run({ ENVIRONMENT: 'local' }, ['--organization', ORGANIZATION])

    for (const result of [both, neither]) {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('exactly one of --call')
    }
  })

  test('a malformed id is refused', () => {
    const result = run({ ENVIRONMENT: 'local' }, [
      '--organization',
      ORGANIZATION,
      '--call',
      DOCUMENT,
    ])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('not a valid id')
  })

  test('with ENVIRONMENT=local and valid arguments it gets past the guards and only then tries the database', () => {
    const result = run({ ENVIRONMENT: 'local' }, BASE)

    expect(result.stderr.toString()).not.toContain('ENVIRONMENT must be')
    expect(result.stderr.toString()).not.toContain('--confirm')
  })
})
