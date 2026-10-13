import { createApp } from './app'
import { loadEnv } from './env'

const env = loadEnv()

Bun.serve({ port: env.PORT, fetch: createApp().fetch })
