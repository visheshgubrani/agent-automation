import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { notificationOutbox } from '../src/db/schema/index.js'
import { enqueueNotification } from '../src/notifications/outbox.js'
import { waitForHeartbeatRow } from '../src/tools/smoke-heartbeat.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

async function createPending(dedupeKey: string): Promise<string> {
  const { notification } = await enqueueNotification(db, {
    kind: 'system',
    dedupeKey,
    body: 'smoke test',
  })
  return notification.id
}

describe('waitForHeartbeatRow', () => {
  it('returns a row that is already sent', async () => {
    const dedupeKey = 'system:heartbeat:already-sent'
    const id = await createPending(dedupeKey)
    await db
      .update(notificationOutbox)
      .set({ status: 'sent', sentAt: new Date(), telegramMessageId: 4242 })
      .where(eq(notificationOutbox.id, id))

    const row = await waitForHeartbeatRow(dedupeKey, { timeoutMs: 500, pollIntervalMs: 10 })

    expect(row).toMatchObject({
      id,
      status: 'sent',
      attemptCount: 0,
      telegramMessageId: 4242,
    })
  })

  it('keeps polling while pending and returns once the worker marks it sent', async () => {
    const dedupeKey = 'system:heartbeat:eventually-sent'
    const id = await createPending(dedupeKey)

    const deliver = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      const [updated] = await db
        .update(notificationOutbox)
        .set({ status: 'sent', sentAt: new Date(), telegramMessageId: 7 })
        .where(eq(notificationOutbox.id, id))
        .returning()
      expect(updated?.status).toBe('sent')
    })()

    const row = await waitForHeartbeatRow(dedupeKey, { timeoutMs: 2_000, pollIntervalMs: 5 })
    await deliver
    expect(row?.status).toBe('sent')
  })

  it('returns undefined after the timeout when no row exists', async () => {
    const started = Date.now()
    const row = await waitForHeartbeatRow('system:heartbeat:never-created', {
      timeoutMs: 30,
      pollIntervalMs: 5,
    })

    expect(row).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })
})
