import { Writable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { GrammyError } from 'grammy'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { notificationOutbox, runs } from '../src/db/schema/index.js'
import { createLogger } from '../src/logger.js'
import {
  DISPATCH_LIMIT_PER_TICK,
  dispatchPendingNotifications,
  runDispatchTick,
} from '../src/notifications/dispatcher.js'
import { enqueueNotification } from '../src/notifications/outbox.js'
import type { InlineButtonRows } from '../src/telegram/buttons.js'
import type { TelegramSender } from '../src/telegram/sender.js'
import { createAccount, createClassification, createMessage, createRun } from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

// The real dispatcher claims with the DB's now(); fixtures are relative to real time.
const PAST = new Date(Date.now() - 60_000)
const STALE = new Date(Date.now() - 11 * 60_000)

const networkError = (code: string) => Object.assign(new Error('fetch failed'), { code })
const timeoutError = () => Object.assign(new Error('send timed out'), { name: 'TimeoutError' })

interface SenderHarness {
  sender: TelegramSender
  sends: string[]
}

/** Records bodies sent (test-only) and applies a per-call behavior. */
function senderFor(
  behavior: (text: string, call: number) => Promise<{ messageId: number }>,
): SenderHarness {
  const sends: string[] = []
  let call = 0
  return {
    sends,
    sender: {
      chatId: 42,
      send: async (text: string) => {
        call += 1
        sends.push(text)
        return behavior(text, call)
      },
    },
  }
}

const okSender = () => senderFor(async () => ({ messageId: Math.floor(Math.random() * 1_000_000) }))

beforeEach(truncateAllTables)
afterAll(closeTestDb)

async function dueSystemRow(dedupeKey: string, body: string): Promise<string> {
  const { notification } = await enqueueNotification(db, {
    kind: 'system',
    dedupeKey,
    body,
    scheduledFor: PAST,
  })
  return notification.id
}

async function dueEmailRow(dedupeKey: string, body: string): Promise<string> {
  const account = await createAccount()
  const run = await createRun()
  const message = await createMessage(account.id)
  const classification = await createClassification(message.id, run.id)
  const { notification } = await enqueueNotification(db, {
    kind: 'email_triage',
    dedupeKey,
    body,
    classificationId: classification.id,
    scheduledFor: PAST,
  })
  return notification.id
}

async function rowById(id: string): Promise<typeof notificationOutbox.$inferSelect> {
  const [row] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.id, id))
  if (!row) throw new Error(`row ${id} missing`)
  return row
}

/**
 * Simulate "the worker crashed right after Telegram accepted the send, before the DB
 * finalize": the row is back in `sending` with no delivery record and a stale attempt time.
 */
async function simulateCrashAfterSend(id: string): Promise<void> {
  await db
    .update(notificationOutbox)
    .set({
      status: 'sending',
      sentAt: null,
      telegramMessageId: null,
      lastAttemptAt: STALE,
      lastError: null,
    })
    .where(eq(notificationOutbox.id, id))
}

describe('dispatchPendingNotifications', () => {
  it('delivers a due row and marks it sent with the telegram message id', async () => {
    const id = await dueSystemRow('system:t1', 'heartbeat body')
    const { sender, sends } = senderFor(async () => ({ messageId: 101 }))

    const counters = await dispatchPendingNotifications({ db, sender })

    expect(counters).toMatchObject({ claimed: 1, sent: 1, retried: 0, quarantined: 0, failed: 0 })
    expect(sends).toEqual(['heartbeat body'])
    const row = await rowById(id)
    expect(row.status).toBe('sent')
    expect(row.telegramMessageId).toBe(101)
    expect(row.sentAt).toBeInstanceOf(Date)
  })

  it('forwards validated payload buttons and omits malformed button data', async () => {
    const account = await createAccount()
    const run = await createRun()
    const withButtonsMessage = await createMessage(account.id)
    const invalidButtonsMessage = await createMessage(account.id)
    const withButtons = await createClassification(withButtonsMessage.id, run.id)
    const invalidButtons = await createClassification(invalidButtonsMessage.id, run.id)
    const buttons: InlineButtonRows = [
      [
        { text: 'Useful', callbackData: `mail:useful:${withButtons.id}` },
        { text: 'Not important', callbackData: `mail:not_important:${withButtons.id}` },
      ],
      [{ text: 'Create rule', callbackData: `mail:create_rule:${withButtons.id}` }],
    ]

    await enqueueNotification(db, {
      kind: 'email_triage',
      dedupeKey: 'email_triage:buttons',
      classificationId: withButtons.id,
      body: 'alert with buttons',
      payload: { inlineButtons: buttons },
      scheduledFor: PAST,
    })
    await enqueueNotification(db, {
      kind: 'email_triage',
      dedupeKey: 'email_triage:bad-buttons',
      classificationId: invalidButtons.id,
      body: 'alert without buttons',
      payload: { inlineButtons: [[{ text: 'x', callbackData: 'x'.repeat(100) }]] },
      scheduledFor: PAST,
    })

    const calls: { text: string; buttons?: InlineButtonRows }[] = []
    const sender: TelegramSender = {
      chatId: 42,
      send: async (text, options) => {
        calls.push({ text, ...(options?.buttons ? { buttons: options.buttons } : {}) })
        return { messageId: calls.length }
      },
    }

    const counters = await dispatchPendingNotifications({ db, sender })
    expect(counters).toMatchObject({ claimed: 2, sent: 2, failed: 0 })

    const withButtonCall = calls.find((call) => call.text === 'alert with buttons')
    const withoutButtonCall = calls.find((call) => call.text === 'alert without buttons')
    expect(withButtonCall?.buttons).toEqual(buttons)
    expect(withoutButtonCall?.buttons).toBeUndefined()
  })

  it('retries safe transport failures with backoff, then succeeds on a later tick', async () => {
    const id = await dueSystemRow('system:t2', 'retry me')
    const firstTick = senderFor(async (_text, call) => {
      if (call === 1) throw networkError('ENOTFOUND')
      return { messageId: 200 + call }
    })

    const counters1 = await dispatchPendingNotifications({ db, sender: firstTick.sender })
    expect(counters1).toMatchObject({ claimed: 1, sent: 0, retried: 1, failed: 0 })

    const afterFirst = await rowById(id)
    expect(afterFirst.status).toBe('pending')
    expect(afterFirst.attemptCount).toBe(1)
    expect(afterFirst.scheduledFor.getTime()).toBeGreaterThan(Date.now())

    // Backoff pushes the row into the future; claim it manually-ish by resetting schedule.
    await db
      .update(notificationOutbox)
      .set({ scheduledFor: PAST })
      .where(eq(notificationOutbox.id, id))
    const counters2 = await dispatchPendingNotifications({ db, sender: firstTick.sender })
    expect(counters2).toMatchObject({ claimed: 1, sent: 1, retried: 0 })
    expect((await rowById(id)).status).toBe('sent')
    expect((await rowById(id)).attemptCount).toBe(2)
  })

  it('never resends an at_most_once row after a crash post-send: quarantine, one delivery', async () => {
    const id = await dueSystemRow('system:t3', 'exactly once')
    const firstTick = okSender()

    await dispatchPendingNotifications({ db, sender: firstTick.sender })
    expect(firstTick.sends).toEqual(['exactly once']) // delivery 1 happened
    await simulateCrashAfterSend(id)

    const secondTick = okSender()
    const counters = await dispatchPendingNotifications({ db, sender: secondTick.sender })

    expect(counters).toMatchObject({ recoveredStale: 1, claimed: 0, sent: 0 })
    expect(secondTick.sends).toEqual([]) // never resent
    const row = await rowById(id)
    expect(row.status).toBe('quarantined')
    expect(row.lastError).toContain('not resent')
  })

  it('redelivers an at_least_once row after a crash post-send: duplicate tolerated', async () => {
    const id = await dueEmailRow('email_triage:t4', 'urgent alert')
    const firstTick = okSender()

    await dispatchPendingNotifications({ db, sender: firstTick.sender })
    expect(firstTick.sends).toEqual(['urgent alert'])
    await simulateCrashAfterSend(id)

    const secondTick = okSender()
    const counters = await dispatchPendingNotifications({ db, sender: secondTick.sender })

    expect(counters).toMatchObject({ recoveredStale: 1, claimed: 1, sent: 1 })
    expect(secondTick.sends).toEqual(['urgent alert']) // duplicate by design
    const row = await rowById(id)
    expect(row.status).toBe('sent')
    expect(row.attemptCount).toBe(2)
  })

  it('fails oversized bodies before calling Telegram', async () => {
    const id = await dueSystemRow('system:t5', 'x'.repeat(5000))
    const { sender, sends } = senderFor(async () => ({ messageId: 1 }))

    const counters = await dispatchPendingNotifications({ db, sender })

    expect(sends).toEqual([])
    expect(counters).toMatchObject({ claimed: 1, sent: 0, failed: 1 })
    const row = await rowById(id)
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain('too long')
  })

  it('fails permanently on a 400 API answer regardless of delivery policy', async () => {
    const id = await dueEmailRow('email_triage:t6', 'bad request')
    const { sender } = senderFor(async () => {
      throw new GrammyError(
        `Call to 'sendMessage' failed!`,
        { ok: false, error_code: 400, description: 'Bad Request: message text is empty' },
        'sendMessage',
        {},
      )
    })

    const counters = await dispatchPendingNotifications({ db, sender })
    expect(counters).toMatchObject({ claimed: 1, failed: 1, retried: 0 })
    const row = await rowById(id)
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain('400')
  })

  it('quarantines at_most_once rows on an uncertain timeout (delivery may have happened)', async () => {
    const id = await dueSystemRow('system:t-timeout', 'timeout case')
    const { sender } = senderFor(async () => {
      throw timeoutError()
    })

    const counters = await dispatchPendingNotifications({ db, sender })
    expect(counters).toMatchObject({ claimed: 1, quarantined: 1, retried: 0 })
    const row = await rowById(id)
    expect(row.status).toBe('quarantined')
    expect(row.lastError).toContain('timeout')
  })

  it('processes at most `limit` rows per tick', async () => {
    await dueSystemRow('system:t7a', 'one')
    await dueSystemRow('system:t7b', 'two')
    await dueSystemRow('system:t7c', 'three')
    const { sender } = senderFor(async (_text, call) => ({ messageId: call }))

    const counters = await dispatchPendingNotifications({ db, sender, limit: 2 })

    expect(counters.claimed).toBe(2)
    const pending = await db.select().from(notificationOutbox)
    expect(pending.filter((r) => r.status === 'pending')).toHaveLength(1)
    expect(DISPATCH_LIMIT_PER_TICK).toBe(10)
  })

  it('stops claiming after the shutdown signal but finalizes the in-flight row', async () => {
    await dueSystemRow('system:t8a', 'in flight')
    await dueSystemRow('system:t8b', 'never claimed')
    const controller = new AbortController()
    let call = 0
    const sender: TelegramSender = {
      chatId: 42,
      send: async () => {
        call += 1
        if (call === 1) {
          // Abort mid-send; the in-flight send still completes and finalizes.
          setTimeout(() => controller.abort(), 5)
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        return { messageId: call }
      },
    }

    const counters = await dispatchPendingNotifications({ db, sender, signal: controller.signal })

    expect(counters).toMatchObject({ claimed: 1, sent: 1, quarantined: 0 })
    const rows = await db.select().from(notificationOutbox)
    const byKey = new Map(rows.map((r) => [r.dedupeKey, r.status]))
    expect(byKey.get('system:t8a')).toBe('sent')
    expect(byKey.get('system:t8b')).toBe('pending')
  })
})

describe('runDispatchTick run gating', () => {
  it('opens no run for an idle tick', async () => {
    const outcome = await runDispatchTick({ db, sender: okSender().sender })
    expect(outcome.runOpened).toBe(false)
    expect(await db.select().from(runs)).toHaveLength(0)
  })

  it('opens exactly one succeeded run when work exists, even with row-level failures', async () => {
    await dueSystemRow('system:t9', 'tick work')
    // A permanently failing sender: the row fails but the run still succeeds.
    const { sender } = senderFor(async () => {
      throw new GrammyError(
        `Call to 'sendMessage' failed!`,
        { ok: false, error_code: 400, description: 'Bad Request' },
        'sendMessage',
        {},
      )
    })

    const outcome = await runDispatchTick({ db, sender })
    expect(outcome.runOpened).toBe(true)
    expect(outcome.result).toMatchObject({ claimed: 1, failed: 1 })

    const [run] = await db.select().from(runs)
    expect(run).toMatchObject({ kind: 'notification_dispatch', status: 'succeeded' })
    expect(run?.finishedAt).toBeInstanceOf(Date)
    expect(run?.input).toEqual({ gate: 'hasDispatchWork' })
  })

  it('audits a failed run when the pre-check throws, and rethrows the original error', async () => {
    // A DB that fails every select (the pre-check) but keeps inserts/updates working.
    const brokenDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'select') {
          throw new Error('pre-check down')
        }
        return Reflect.get(target, property, receiver)
      },
    })

    await expect(
      runDispatchTick({ db: brokenDb as typeof db, sender: okSender().sender }),
    ).rejects.toThrow('pre-check down')

    const [run] = await db.select().from(runs)
    expect(run).toMatchObject({ kind: 'notification_dispatch', status: 'failed' })
    expect(run?.error).toContain('pre-check down')
    expect(run?.finishedAt).toBeInstanceOf(Date)
  })

  it('never logs message bodies', async () => {
    const chunks: string[] = []
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk))
        callback()
      },
    })
    const log = createLogger({ level: 'debug', pretty: false, destination })
    await dueSystemRow('system:t10', 'SECRET-BODY-XYZ')
    const { sender } = senderFor(async () => {
      throw networkError('ENOTFOUND')
    })

    await runDispatchTick({ db, sender, log })

    await new Promise((resolve) => setTimeout(resolve, 20))
    const all = chunks.join('')
    expect(all).not.toContain('SECRET-BODY-XYZ')
    expect(all).toContain('"claimed":1')
  })
})
