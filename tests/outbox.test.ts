import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { notificationOutbox } from '../src/db/schema/index.js'
import {
  BASE_BACKOFF_SECONDS,
  claimNextDue,
  enqueueNotification,
  expireDue,
  hasDispatchWork,
  MAX_BACKOFF_SECONDS,
  MAX_SEND_ATTEMPTS,
  markFailed,
  markQuarantined,
  markRetry,
  markSent,
  recoverStaleSending,
  retryDelaySeconds,
  STALE_SENDING_AFTER_MS,
} from '../src/notifications/outbox.js'
import {
  createAccount,
  createApproval,
  createClassification,
  createEmailNotification,
  createMessage,
  createRun,
  createSystemNotification,
} from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

const NOW = new Date('2026-10-19T12:00:00Z')

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000)
}

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('enqueueNotification', () => {
  it('maps kind → policy and honours explicit overrides', async () => {
    const system = await enqueueNotification(db, {
      kind: 'system',
      dedupeKey: 'system:t1',
      body: 'system body',
    })
    expect(system.notification.deliveryPolicy).toBe('at_most_once')

    const overridden = await enqueueNotification(db, {
      kind: 'system',
      dedupeKey: 'system:t2',
      body: 'system body',
      deliveryPolicy: 'at_least_once',
    })
    expect(overridden.notification.deliveryPolicy).toBe('at_least_once')

    const { classification } = await (async () => {
      const account = await createAccount()
      const run = await createRun()
      const message = await createMessage(account.id)
      return { classification: await createClassification(message.id, run.id) }
    })()
    const email = await enqueueNotification(db, {
      kind: 'email_triage',
      dedupeKey: 'email_triage:t1',
      body: 'email body',
      classificationId: classification.id,
    })
    expect(email.notification.deliveryPolicy).toBe('at_least_once')
  })

  it('is idempotent on the dedupe key: a retried job does not insert twice', async () => {
    const first = await enqueueNotification(db, {
      kind: 'system',
      dedupeKey: 'system:heartbeat:job-1',
      body: 'v1',
    })
    expect(first.inserted).toBe(true)

    const second = await enqueueNotification(db, {
      kind: 'system',
      dedupeKey: 'system:heartbeat:job-1',
      body: 'v2',
    })
    expect(second.inserted).toBe(false)
    expect(second.notification.id).toBe(first.notification.id)
    expect(second.notification.body).toBe('v1')

    const rows = await db.select().from(notificationOutbox)
    expect(rows).toHaveLength(1)
  })

  it('snapshots approval_request rows as at_least_once with the approval context', async () => {
    const run = await createRun()
    const approval = await createApproval(run.id)
    const result = await enqueueNotification(db, {
      kind: 'approval_request',
      dedupeKey: 'approval:t1',
      body: 'approval body',
      approvalId: approval.id,
    })
    expect(result.notification.deliveryPolicy).toBe('at_least_once')
  })
})

describe('claimNextDue', () => {
  it('claims due telegram rows oldest-scheduled first, one at a time', async () => {
    const a = await createSystemNotification({
      dedupeKey: 'system:a',
      body: 'a',
      scheduledFor: minutesAgo(1),
    })
    await createSystemNotification({
      dedupeKey: 'system:future',
      body: 'future',
      scheduledFor: new Date(NOW.getTime() + 60_000),
    })

    const first = await claimNextDue(db, { now: NOW })
    expect(first?.id).toBe(a.id)
    expect(first?.status).toBe('sending')
    expect(first?.attemptCount).toBe(1)
    expect(first?.lastAttemptAt).toEqual(NOW)

    const second = await claimNextDue(db, { now: NOW })
    expect(second).toBeUndefined()
  })

  it('skips rows whose expires_at has passed and never re-claims sending rows', async () => {
    await createSystemNotification({
      dedupeKey: 'system:expiring',
      body: 'x',
      createdAt: minutesAgo(10),
      expiresAt: minutesAgo(1),
    })
    await createSystemNotification({
      dedupeKey: 'system:inflight',
      body: 'x',
      status: 'sending',
      attemptCount: 1,
      lastAttemptAt: NOW,
    })

    expect(await claimNextDue(db, { now: NOW })).toBeUndefined()
    expect(await hasDispatchWork(db, { now: NOW })).toBe(true) // expiry work remains
  })

  it('increments attempts on every claim', async () => {
    const row = await createSystemNotification({ scheduledFor: minutesAgo(1) })
    await claimNextDue(db, { now: NOW })
    const second = await claimNextDue(db, { now: NOW }) // still sending → nothing new
    expect(second).toBeUndefined()

    // Force back to pending, claim again.
    await markRetry(db, row.id, { reason: 'test', delaySeconds: 0, now: NOW })
    const reclaimed = await claimNextDue(db, { now: NOW })
    expect(reclaimed?.attemptCount).toBe(2)
  })
})

describe('expireDue', () => {
  it('expires overdue pending rows and leaves the rest alone', async () => {
    await createSystemNotification({
      dedupeKey: 'system:old',
      createdAt: minutesAgo(10),
      expiresAt: minutesAgo(5),
    })
    await createSystemNotification({
      dedupeKey: 'system:new',
      createdAt: minutesAgo(10),
      expiresAt: new Date(NOW.getTime() + 60_000),
    })
    await createSystemNotification({ dedupeKey: 'system:noexpiry' })
    await createSystemNotification({
      dedupeKey: 'system:sent',
      status: 'sent',
      sentAt: NOW,
      expiresAt: minutesAgo(1), // sent rows are not expirable
      createdAt: minutesAgo(10),
    })

    const count = await expireDue(db, { now: NOW })
    expect(count).toBe(1)

    const rows = await db.select().from(notificationOutbox)
    const byKey = new Map(rows.map((r) => [r.dedupeKey, r.status]))
    expect(byKey.get('system:old')).toBe('expired')
    expect(byKey.get('system:new')).toBe('pending')
    expect(byKey.get('system:noexpiry')).toBe('pending')
    expect(byKey.get('system:sent')).toBe('sent')
  })
})

describe('recoverStaleSending', () => {
  it('quarantines stale at_most_once rows and requeues stale at_least_once rows', async () => {
    await createSystemNotification({
      dedupeKey: 'system:stale',
      status: 'sending',
      attemptCount: 1,
      lastAttemptAt: minutesAgo(11),
    })
    const { classification } = await (async () => {
      const account = await createAccount()
      const run = await createRun()
      const message = await createMessage(account.id)
      return { classification: await createClassification(message.id, run.id) }
    })()
    await createEmailNotification(classification.id, {
      dedupeKey: 'email_triage:stale',
      status: 'sending',
      attemptCount: 3,
      deliveryPolicy: 'at_least_once',
      lastAttemptAt: minutesAgo(11),
    })
    await createSystemNotification({
      dedupeKey: 'system:fresh',
      status: 'sending',
      attemptCount: 1,
      lastAttemptAt: minutesAgo(5), // younger than the stale age
    })

    const counts = await recoverStaleSending(db, { now: NOW })
    expect(counts).toEqual({ quarantined: 1, requeued: 1 })

    const rows = await db.select().from(notificationOutbox)
    const byKey = new Map(rows.map((r) => [r.dedupeKey, r]))
    expect(byKey.get('system:stale')?.status).toBe('quarantined')
    expect(byKey.get('system:stale')?.lastError).toContain('not resent')
    const requeued = byKey.get('email_triage:stale')
    expect(requeued?.status).toBe('pending')
    expect(requeued?.scheduledFor).toEqual(NOW)
    expect(byKey.get('system:fresh')?.status).toBe('sending')
  })

  it('uses the stale age: rows recovered only after 10 minutes', async () => {
    await createSystemNotification({
      dedupeKey: 'system:edge',
      status: 'sending',
      attemptCount: 1,
      lastAttemptAt: minutesAgo(10),
    })
    // Exactly at the boundary: 10 minutes elapsed = stale (before now - 10min is false →
    // lt is strict, so exactly-at is NOT stale).
    expect(await recoverStaleSending(db, { now: NOW })).toEqual({ quarantined: 0, requeued: 0 })
    expect(await recoverStaleSending(db, { now: new Date(NOW.getTime() + 1_000) })).toEqual({
      quarantined: 1,
      requeued: 0,
    })
  })
})

describe('markSent / markRetry / markFailed / markQuarantined', () => {
  it('records a sent delivery with the telegram message id', async () => {
    const row = await createSystemNotification()
    await markSent(db, row.id, { telegramMessageId: 555, sentAt: NOW })
    const [updated] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, row.id))
    expect(updated?.status).toBe('sent')
    expect(updated?.sentAt).toEqual(NOW)
    expect(updated?.telegramMessageId).toBe(555)
  })

  it('schedules retries with exponential backoff, retry_after floor, and 1h cap', async () => {
    const row = await createSystemNotification()

    expect(retryDelaySeconds(1)).toBe(BASE_BACKOFF_SECONDS)
    expect(retryDelaySeconds(2)).toBe(2 * BASE_BACKOFF_SECONDS)
    expect(retryDelaySeconds(4)).toBe(8 * BASE_BACKOFF_SECONDS)
    expect(retryDelaySeconds(6)).toBe(32 * BASE_BACKOFF_SECONDS)
    expect(retryDelaySeconds(7)).toBe(MAX_BACKOFF_SECONDS) // 60 * 2^6 exceeds the 1h cap
    expect(retryDelaySeconds(1, 900)).toBe(900) // respect Telegram retry_after
    expect(retryDelaySeconds(1, 7200)).toBe(MAX_BACKOFF_SECONDS)

    await markRetry(db, row.id, { reason: 'network ENOTFOUND', delaySeconds: 120, now: NOW })
    const [pending] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, row.id))
    expect(pending?.status).toBe('pending')
    expect(pending?.scheduledFor).toEqual(new Date(NOW.getTime() + 120_000))
    expect(pending?.lastError).toBe('network ENOTFOUND')
  })

  it('marks terminal failed and quarantined with reasons', async () => {
    const failed = await createSystemNotification({ dedupeKey: 'system:f' })
    await markFailed(db, failed.id, 'telegram 400')
    const quarantined = await createSystemNotification({ dedupeKey: 'system:q' })
    await markQuarantined(db, quarantined.id, 'delivery uncertain')

    const rows = await db.select().from(notificationOutbox)
    const byKey = new Map(rows.map((r) => [r.dedupeKey, r]))
    expect(byKey.get('system:f')?.status).toBe('failed')
    expect(byKey.get('system:f')?.lastError).toBe('telegram 400')
    expect(byKey.get('system:q')?.status).toBe('quarantined')
    expect(byKey.get('system:q')?.lastError).toBe('delivery uncertain')
    expect(MAX_SEND_ATTEMPTS).toBe(5)
    expect(STALE_SENDING_AFTER_MS).toBe(10 * 60 * 1000)
  })
})

describe('hasDispatchWork', () => {
  it('is false with no rows or only future/idle rows', async () => {
    expect(await hasDispatchWork(db, { now: NOW })).toBe(false)
    await createSystemNotification({
      dedupeKey: 'system:future',
      scheduledFor: new Date(NOW.getTime() + 60_000),
    })
    await createSystemNotification({ dedupeKey: 'system:sent', status: 'sent', sentAt: NOW })
    expect(await hasDispatchWork(db, { now: NOW })).toBe(false)
  })

  it('is true for due, expired, or stale-sending work', async () => {
    await createSystemNotification({ dedupeKey: 'system:due', scheduledFor: minutesAgo(1) })
    expect(await hasDispatchWork(db, { now: NOW })).toBe(true)

    await truncateAllTables()
    await createSystemNotification({
      dedupeKey: 'system:expired',
      createdAt: minutesAgo(10),
      expiresAt: minutesAgo(1),
    })
    expect(await hasDispatchWork(db, { now: NOW })).toBe(true)

    await truncateAllTables()
    await createSystemNotification({
      dedupeKey: 'system:stale',
      status: 'sending',
      attemptCount: 1,
      lastAttemptAt: minutesAgo(11),
    })
    expect(await hasDispatchWork(db, { now: NOW })).toBe(true)
  })
})
