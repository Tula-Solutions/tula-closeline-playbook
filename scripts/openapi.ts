// Writes the OpenAPI document to openapi.json, or with --check fails if the file is out of date.
import { createApp } from '~/app'
import { createContainer } from '~/container'
import { loadEnv } from '~/env'
import { buildOpenApiDocument } from '~/openapi'

const FILE = new URL('../openapi.json', import.meta.url)

const document = buildOpenApiDocument(
  createApp(createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' })))
)
const next = `${JSON.stringify(document, null, 2)}\n`

if (process.argv.includes('--check')) {
  // Compared as data, not text: the pre-commit hook runs Biome over openapi.json, which lays out
  // short arrays differently from JSON.stringify.
  const current = (await Bun.file(FILE).exists()) ? await Bun.file(FILE).json() : undefined
  if (!Bun.deepEquals(current, document)) {
    process.stderr.write('openapi.json is out of date: run `bun run openapi` and commit it.\n')
    process.exit(1)
  }
} else {
  await Bun.write(FILE, next)
}
