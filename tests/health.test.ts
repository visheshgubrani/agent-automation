import { Writable } from 'node:stream'
import type { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createLogger } from '../src/logger.js'
import { acquireWorkerLock, isWorkerLockHeld } from '../src/worker-lock.js'
import {
  createAccount,
  createMailboxSyncState,
  createMessage,
  createRun,
  createSystemNotification,
} from './db/fixtures.js'
import { closeTestDb, pool, truncateAllTables } from './db/helpers.js'

const TEST_DATABASE_URL = process.env.DATABASE_URL
if (!TEST_DATABASE_URL) throw new Error('DATABASE_URL is required for health tests')

const DETAILS_TOKEN = process.env.HEALTH_DETAILS_TOKEN
if (!DETAILS_TOKEN) throw new Error('HEALTH_DETAILS_TOKEN is required for health tests')

const app = createApp()

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('GET /health (public liveness)', () => {
  it('answers 200 {ok:true} with no internals when the DB is reachable', async () => {
    const response = await app.request('/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('answers 503 {ok:false} when the DB is unreachable', async () => {
    const down = createApp({ healthCheck: () => Promise.resolve(false) })
    const response = await down.request('/health')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false })
  })
})

describe('GET /health/ready (public readiness)', () => {
  it('answers 503 while the worker lock is not held, 200 once it is', async () => {
    expect(await isWorkerLockHeld(pool)).toBe(false)
    const lockedDown = await app.request('/health/ready')
    expect(lockedDown.status).toBe(503)
    expect(await lockedDown.json()).toEqual({ ok: false })

    const lock = await acquireWorkerLock(TEST_DATABASE_URL)
    if (!lock) throw new Error('expected to acquire the worker lock')
    try {
      const ready = await app.request('/health/ready')
      expect(ready.status).toBe(200)
      expect(await ready.json()).toEqual({ ok: true })
    } finally {
      await lock.release()
    }
  })

  it('answers 503 when the DB is down even with the lock held', async () => {
    const lock = await acquireWorkerLock(TEST_DATABASE_URL)
    if (!lock) throw new Error('expected to acquire the worker lock')
    try {
      const downButLocked = createApp({ healthCheck: () => Promise.resolve(false) })
      const response = await downButLocked.request('/health/ready')
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ ok: false })
    } finally {
      await lock.release()
    }
  })
})

describe('GET /health/details (token protected)', () => {
  it('404s when no token is configured, before any auth check', async () => {
    const tokenless = createApp({ healthDetailsToken: undefined })
    const response = await tokenless.request('/health/details', {
      headers: { Authorization: `Bearer ${DETAILS_TOKEN}` },
    })
    expect(response.status).toBe(404)
  })

  it('401s on a missing, malformed, or wrong token', async () => {
    expect((await app.request('/health/details')).status).toBe(401)
    expect(
      (await app.request('/health/details', { headers: { Authorization: 'wrong-scheme' } })).status,
    ).toBe(401)
    expect(
      (await app.request('/health/details', { headers: { Authorization: 'Bearer nope' } })).status,
    ).toBe(401)
  })

  it('200s with the expected shape and live counts for the right token', async () => {
    // Seed outbox rows and runs so the counts have content.
    await createSystemNotification({ dedupeKey: 'system:due-a' })
    await createSystemNotification({ dedupeKey: 'system:due-b' })
    await createSystemNotification({
      dedupeKey: 'system:sending',
      status: 'sending',
      attemptCount: 1,
    })
    await createSystemNotification({ dedupeKey: 'system:quarantined', status: 'quarantined' })
    await createSystemNotification({ dedupeKey: 'system:failed', status: 'failed', lastError: 'x' })
    const dispatchRun = await createRun({ kind: 'notification_dispatch', trigger: 'schedule' })
    const heartbeatRun = await createRun({
      kind: 'system',
      trigger: 'schedule',
      input: { job: 'heartbeat' },
    })
    const mailSyncRun = await createRun({ kind: 'mail_sync', trigger: 'schedule' })
    const account = await createAccount({ emailAddress: 'health@example.test' })
    await createMailboxSyncState(account.id, {
      notificationBoundaryAt: new Date(),
      consecutiveFailures: 1,
      lastError: 'sync temporarily failed',
    })
    await createMessage(account.id, { triageStatus: 'pending' })

    const response = await app.request('/health/details', {
      headers: { Authorization: `Bearer ${DETAILS_TOKEN}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      db: boolean
      worker: {
        locked: boolean
        lastDispatchAt: string | null
        lastHeartbeatAt: string | null
        lastMailSyncAt: string | null
      }
      outbox: { due: number; sending: number; quarantined: number; failed: number }
      mail: {
        enabled: boolean
        accounts: {
          total: number
          active: number
          paused: number
          revoked: number
          error: number
          failing: number
        }
        backlog: { pending: number; runnable: number; failed: number; exhausted: number }
        spend: {
          timezone: string
          dailyLimitUsd: number | null
          totalUsd: number
          canAdmit: boolean
        }
      }
      telegramConfigured: boolean
      uptimeSeconds: number
      timestamp: string
    }

    expect(body.ok).toBe(true)
    expect(body.db).toBe(true)
    expect(body.worker.locked).toBe(false) // no worker running in tests
    expect(body.worker.lastDispatchAt).toBe(dispatchRun.startedAt.toISOString())
    expect(body.worker.lastHeartbeatAt).toBe(heartbeatRun.startedAt.toISOString())
    expect(body.worker.lastMailSyncAt).toBe(mailSyncRun.startedAt.toISOString())
    expect(body.outbox).toEqual({ due: 2, sending: 1, quarantined: 1, failed: 1 })
    expect(typeof body.mail.enabled).toBe('boolean')
    expect(body.mail.accounts).toMatchObject({ total: 1, failing: 1 })
    expect(body.mail.backlog).toMatchObject({ pending: 1, runnable: 1 })
    expect(body.mail.spend).toMatchObject({
      timezone: 'Asia/Kolkata',
      dailyLimitUsd: 1,
      totalUsd: 0,
      canAdmit: true,
    })
    expect(body.telegramConfigured).toBe(true)
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date')
  })

  it('503s when the DB is down', async () => {
    const down = createApp({ healthCheck: () => Promise.resolve(false) })
    const response = await down.request('/health/details', {
      headers: { Authorization: `Bearer ${DETAILS_TOKEN}` },
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false })
  })
})

describe('app plumbing', () => {
  it('stamps a fresh X-Request-Id on every response', async () => {
    const first = await app.request('/health')
    const second = await app.request('/health')
    const firstId = first.headers.get('X-Request-Id')
    const secondId = second.headers.get('X-Request-Id')
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/)
    expect(secondId).toMatch(/^[0-9a-f-]{36}$/)
    expect(firstId).not.toBe(secondId)
  })

  it('returns a JSON 500 that leaks no error details', async () => {
    const leakyApp = createApp() as Hono
    leakyApp.get('/boom', () => {
      throw new Error('SECRET-INTERNAL-DETAIL')
    })
    const response = await leakyApp.request('/boom')
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toEqual({ error: 'internal server error' })
    expect(JSON.stringify(body)).not.toContain('SECRET-INTERNAL-DETAIL')
  })

  it('logs requests with method, path, and status, and never the details token', async () => {
    const chunks: string[] = []
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk))
        callback()
      },
    })
    const loggingApp = createApp({
      log: createLogger({ level: 'info', pretty: false, destination }),
    })

    await loggingApp.request('/health/details', {
      headers: { Authorization: `Bearer ${DETAILS_TOKEN}` },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const all = chunks.join('')
    expect(all).toContain('"msg":"http request"')
    expect(all).toContain('"path":"/health/details"')
    expect(all).toContain('"status":200')
    expect(all).not.toContain(DETAILS_TOKEN)
  })
})
