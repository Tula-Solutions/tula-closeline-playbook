import { expect, test } from 'bun:test'
import { createApp, SERVICE } from './app'
import { loadEnv } from './env'

test('the health endpoint names the service and the shared libraries it resolved', async () => {
  const response = await createApp().request('/healthz')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    status: 'ok',
    service: SERVICE,
    libraries: ['tula-closeline-contract', 'tula-closeline-db', 'tula-closeline-kit'],
  })
})

test('configuration falls back to local defaults', () => {
  expect(loadEnv({})).toEqual({ ENVIRONMENT: 'local', PORT: 3000 })
})

test('configuration rejects an unknown environment at boot', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'production' })).toThrow()
})
