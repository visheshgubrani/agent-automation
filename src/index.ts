import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { pool } from './db/index.js'
import { env } from './env.js'
import { errorMessage } from './errors.js'
import { logger } from './logger.js'

const log = logger.child({ process: 'api' })

const app = createApp()

log.info({ port: env.APP_PORT }, 'API starting')
const server = serve({ fetch: app.fetch, port: env.APP_PORT }, (info) => {
  log.info({ port: info.port }, 'API listening')
})
server.on('error', (error) => {
  log.fatal({ err: errorMessage(error) }, 'API server error')
  process.exit(1)
})

let draining = false
async function shutdown(signal: string): Promise<void> {
  if (draining) {
    log.warn('second shutdown signal received; forcing exit')
    process.exit(1)
  }
  draining = true
  const forceExit = setTimeout(() => {
    log.fatal('API drain did not finish in time; forcing exit')
    process.exit(1)
  }, 10_000)
  forceExit.unref()

  try {
    log.info({ signal }, 'shutdown requested; draining')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
    log.info('API shut down cleanly')
    process.exit(0)
  } catch (error) {
    log.fatal({ err: errorMessage(error) }, 'error during API shutdown')
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal))
}
