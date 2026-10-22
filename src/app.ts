import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { checkDb } from './db/index.js'
import { env } from './env.js'
import { errorMessage } from './errors.js'
import { type HealthProbe, healthDetails, isDbUp, isReady } from './health.js'
import { type Logger, logger } from './logger.js'

export interface CreateAppOptions {
  /** DB probe override (tests); defaults to the real `checkDb()`. */
  healthCheck?: HealthProbe
  /** Override of `HEALTH_DETAILS_TOKEN`; explicit `undefined` disables the details route. */
  healthDetailsToken?: string
  log?: Logger
}

/** Compare two secret strings without short-circuiting on length or content. */
function safeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  const length = Math.max(a.length, b.length, 1)
  const paddedA = Buffer.concat([a, Buffer.alloc(length - a.length)])
  const paddedB = Buffer.concat([b, Buffer.alloc(length - b.length)])
  return timingSafeEqual(paddedA, paddedB) && a.length === b.length
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/.exec(header ?? '')
  return match?.[1]
}

/**
 * The API app: request-id + pino request logs, JSON error handling that leaks no details,
 * and the split health routes (D025):
 *
 * - `GET /health` — public liveness: 200 `{ok:true}` iff the DB is reachable.
 * - `GET /health/ready` — public readiness: 200 iff DB reachable and the worker lock is held.
 * - `GET /health/details` — token-protected detail; 404 when the token is unset, 401 when
 *   missing/wrong, 503 when the DB is down.
 */
export function createApp(options: CreateAppOptions = {}) {
  const healthCheck = options.healthCheck ?? checkDb
  const log = options.log ?? logger
  const detailsToken =
    'healthDetailsToken' in options ? options.healthDetailsToken : env.HEALTH_DETAILS_TOKEN

  const app = new Hono<{ Variables: { requestId: string } }>()

  app.use(async (c, next) => {
    const requestId = randomUUID()
    c.set('requestId', requestId)
    const started = Date.now()
    await next()
    c.res.headers.set('X-Request-Id', requestId)
    log.child({ requestId }).info(
      {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        durationMs: Date.now() - started,
      },
      'http request',
    )
  })

  app.onError((error, c) => {
    log.error(
      { err: errorMessage(error), requestId: c.get('requestId') },
      'unhandled request error',
    )
    return c.json({ error: 'internal server error' }, 500)
  })

  app.get('/health', async (c) => {
    const ok = await isDbUp(healthCheck)
    return c.json({ ok }, ok ? 200 : 503)
  })

  app.get('/health/ready', async (c) => {
    const ok = await isReady(healthCheck)
    return c.json({ ok }, ok ? 200 : 503)
  })

  app.get('/health/details', async (c) => {
    if (!detailsToken) {
      return c.json({ error: 'not found' }, 404)
    }
    const provided = bearerToken(c.req.header('Authorization'))
    if (provided === undefined || !safeTokenEqual(provided, detailsToken)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const details = await healthDetails(healthCheck)
    if (!details.db) {
      return c.json({ ok: false }, 503)
    }
    return c.json({ ok: true, ...details }, 200)
  })

  return app
}
