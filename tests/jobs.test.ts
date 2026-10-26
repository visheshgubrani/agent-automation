import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { notificationOutbox, runs } from '../src/db/schema/index.js'
import { handleDispatchJob } from '../src/jobs/dispatch.js'
import { handleHeartbeatJob, heartbeatBody } from '../src/jobs/heartbeat.js'
import { enqueueNotification } from '../src/notifications/outbox.js'
import type { TelegramSender } from '../src/telegram/sender.js'
import { createAccount, createMessage, createSystemNotification } from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

const JOB_ID = '11111111-2222-4333-8444-555555555555'

const okSender: TelegramSender = {
  chatId: 42,
  send: async () => ({ messageId: 7 }),
  sendPhoto: async () => ({ messageId: 8 }),
}

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('heartbeat job', () => {
  it('inserts one system row with a run, and reports quarantine/failed counts', async () => {
    await createSystemNotification({ dedupeKey: 'system:q1', status: 'quarantined' })
    await createSystemNotification({ dedupeKey: 'system:q2', status: 'quarantined' })
    await createSystemNotification({ dedupeKey: 'system:f1', status: 'failed', lastError: 'x' })

    const result = await handleHeartbeatJob({ jobId: JOB_ID })

    expect(result.inserted).toBe(true)
    expect(result.quarantined).toBe(2)
    expect(result.failed).toBe(1)

    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, result.notificationId))
    expect(row?.kind).toBe('system')
    expect(row?.deliveryPolicy).toBe('at_most_once')
    expect(row?.dedupeKey).toBe(`system:heartbeat:${JOB_ID}`)
    expect(row?.runId).toBe(result.runId)
    expect(row?.body).toContain('had uncertain delivery')
    expect(row?.body).toContain('1 notification failed')
    expect(row?.body).toContain(new Date().getFullYear().toString())

    const [run] = await db.select().from(runs).where(eq(runs.id, result.runId))
    expect(run).toMatchObject({
      kind: 'system',
      trigger: 'schedule',
      status: 'succeeded',
      bossJobId: JOB_ID,
    })
    expect(run?.finishedAt).toBeInstanceOf(Date)
  })

  it('omits summary lines when there is nothing to report', () => {
    const body = heartbeatBody(new Date('2026-10-19T09:00:00Z'), 0, 0)
    expect(body).toBe('heartbeat 2026-10-19T09:00:00.000Z — worker is alive')
  })

  it('includes mail backlog and budget visibility when mail state exists', async () => {
    const account = await createAccount()
    await createMessage(account.id, { triageStatus: 'pending' })

    const result = await handleHeartbeatJob({ jobId: JOB_ID })

    expect(result.mail).toMatchObject({
      pending: 1,
      failed: 0,
      totalUsd: 0,
      dailyLimitUsd: 1,
    })
    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, result.notificationId))
    expect(row?.body).toContain('mail: 1 pending, 0 failed, $0.00/$1.00 today')
  })

  it('does not duplicate the row when the job is retried', async () => {
    await handleHeartbeatJob({ jobId: JOB_ID })
    const retried = await handleHeartbeatJob({ jobId: JOB_ID })

    expect(retried.inserted).toBe(false)
    const rows = await db.select().from(notificationOutbox)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dedupeKey).toBe(`system:heartbeat:${JOB_ID}`)

    // Each attempt opens its own run; the row stays single.
    const runRows = await db.select().from(runs)
    expect(runRows).toHaveLength(2)
    expect(runRows.every((r) => r.bossJobId === JOB_ID)).toBe(true)
  })

  it('uses the manual trigger for manually sent heartbeats', async () => {
    const result = await handleHeartbeatJob({ jobId: JOB_ID, data: { source: 'manual' } })
    const [run] = await db.select().from(runs).where(eq(runs.id, result.runId))
    expect(run?.trigger).toBe('manual')
  })
})

describe('dispatch job', () => {
  it('opens no run when idle', async () => {
    const outcome = await handleDispatchJob({ jobId: JOB_ID, sender: okSender })
    expect(outcome.runOpened).toBe(false)
    expect(await db.select().from(runs)).toHaveLength(0)
  })

  it('opens one run and sends when due work exists', async () => {
    const { notification } = await enqueueNotification(db, {
      kind: 'system',
      dedupeKey: 'system:due',
      body: 'dispatch me',
      scheduledFor: new Date(Date.now() - 60_000),
    })

    const outcome = await handleDispatchJob({ jobId: JOB_ID, sender: okSender })
    expect(outcome.runOpened).toBe(true)
    expect(outcome.result).toMatchObject({ claimed: 1, sent: 1 })

    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, notification.id))
    expect(row?.status).toBe('sent')

    const [run] = await db.select().from(runs)
    expect(run).toMatchObject({
      kind: 'notification_dispatch',
      trigger: 'schedule',
      status: 'succeeded',
      bossJobId: JOB_ID,
    })
  })

  it('opens a run for stale-sending work and recovers it by policy', async () => {
    await createSystemNotification({
      dedupeKey: 'system:stale',
      status: 'sending',
      attemptCount: 1,
      lastAttemptAt: new Date(Date.now() - 11 * 60_000),
    })

    const outcome = await handleDispatchJob({ jobId: JOB_ID, sender: okSender })
    expect(outcome.runOpened).toBe(true)
    expect(outcome.result).toMatchObject({ recoveredStale: 1, claimed: 0 })

    const [row] = await db.select().from(notificationOutbox)
    expect(row?.status).toBe('quarantined') // at_most_once: never resent
  })
})
