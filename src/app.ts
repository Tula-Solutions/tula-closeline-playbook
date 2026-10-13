import { Hono } from 'hono'
import { PACKAGE as CONTRACT } from 'tula-closeline-contract'
import { PACKAGE as DB } from 'tula-closeline-db'
import { PACKAGE as KIT } from 'tula-closeline-kit'

/** This service's name, as reported by its health endpoint. */
export const SERVICE = 'tula-closeline-playbook'

/** Build the HTTP app. Modules are mounted here as they are added. */
export function createApp(): Hono {
  const app = new Hono()

  app.get('/healthz', (c) =>
    c.json({ status: 'ok', service: SERVICE, libraries: [CONTRACT, DB, KIT] })
  )

  return app
}
