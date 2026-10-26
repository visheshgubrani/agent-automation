import { and, eq } from 'drizzle-orm'
import type { Update } from 'grammy/types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  approvals,
  browserTasks,
  notificationOutbox,
  runs,
  telegramMessages,
  telegramUpdates,
} from '../src/db/schema/index.js'
import { handleTelegramUpdate } from '../src/telegram/updates.js'
import { createApproval, createBrowserTask, createRun } from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'
import { THREAD_URL } from './fakes/browser.js'

const CHAT_ID = 42
const COMMENT = 'Exact words, one line.'

let updateSeq = 100

function messageUpdate(text: string, messageId = 600): Update {
  updateSeq += 1
  return {
    update_id: updateSeq,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: 'private', first_name: 'Tester' },
      from: { id: CHAT_ID, is_bot: false, first_name: 'Tester' },
      text,
    },
  } as unknown as Update
}

function callbackUpdate(data: string, messageId: number): Update {
  updateSeq += 1
  return {
    update_id: updateSeq,
    callback_query: {
      id: `callback-${updateSeq}`,
      from: { id: CHAT_ID, is_bot: false, first_name: 'Tester' },
      chat_instance: 'chat-instance',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: 'private', first_name: 'Tester' },
        text: 'card',
      },
    },
  } as unknown as Update
}

function transport() {
  const replies: string[] = []
  const answers: (string | undefined)[] = []
  return {
    replies,
    answers,
    reply: async (text: string) => {
      replies.push(text)
      return 1_000 + replies.length
    },
    editMessage: async () => undefined,
    answerCallback: async (text?: string) => {
      answers.push(text)
    },
  }
}

interface SentCardOptions {
  dedupeKey: string
  telegramMessageId: number
  kind?: 'system' | 'approval_request'
  body?: string
  approvalId?: string
  expiresAt?: Date
  createdAt?: Date
}

async function sentCard(options: SentCardOptions) {
  const [row] = await db
    .insert(notificationOutbox)
    .values({
      kind: options.kind ?? 'system',
      dedupeKey: options.dedupeKey,
      body: options.body ?? 'card',
      status: 'sent',
      sentAt: new Date(),
      telegramMessageId: options.telegramMessageId,
      ...(options.approvalId !== undefined ? { approvalId: options.approvalId } : {}),
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
    })
    .returning()
  if (!row) throw new Error('missing outbox row')
  return row
}

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('/comment command', () => {
  it('stores the message and enqueues deterministic intake without replying inline', async () => {
    const enqueued: { queue: string; data: Record<string, unknown> }[] = []
    const t = transport()

    await handleTelegramUpdate(messageUpdate(`/comment ${THREAD_URL}\n${COMMENT}`), {
      chatId: CHAT_ID,
      db,
      ...t,
      enqueue: async (queue, data) => {
        enqueued.push({ queue, data })
      },
    })

    expect(t.replies).toEqual([])
    const [inbound] = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.direction, 'inbound'))
    expect(inbound?.text).toContain('/comment')
    expect(enqueued).toEqual([{ queue: 'agent-intake', data: { telegramMessageId: inbound?.id } }])
    const [run] = await db.select().from(runs)
    expect(run).toMatchObject({ kind: 'agent_chat', trigger: 'telegram', status: 'succeeded' })
  })

  it('answers malformed commands with usage and enqueues nothing', async () => {
    const enqueued: string[] = []
    const t = transport()
    await handleTelegramUpdate(messageUpdate('/comment not-a-thread'), {
      chatId: CHAT_ID,
      db,
      ...t,
      enqueue: async (queue) => {
        enqueued.push(queue)
      },
    })
    expect(t.replies).toHaveLength(1)
    expect(t.replies[0]).toContain('Usage: /comment')
    expect(enqueued).toEqual([])
    expect(await db.select().from(browserTasks)).toHaveLength(0)
  })

  it('reports a disabled agent when no enqueue is wired', async () => {
    const t = transport()
    await handleTelegramUpdate(messageUpdate(`/comment ${THREAD_URL}\n${COMMENT}`), {
      chatId: CHAT_ID,
      db,
      ...t,
    })
    expect(t.replies).toEqual(['Browser tasks are not enabled on this worker.'])
  })

  it('reports a queue failure and records the update error', async () => {
    const t = transport()
    await handleTelegramUpdate(messageUpdate(`/comment ${THREAD_URL}\n${COMMENT}`), {
      chatId: CHAT_ID,
      db,
      ...t,
      enqueue: async () => {
        throw new Error('queue down')
      },
    })
    expect(t.replies).toEqual(['Could not queue the comment task; check the worker logs.'])
    const [update] = await db.select().from(telegramUpdates)
    expect(update?.error).toContain('queue down')
  })
})

describe('bt: approval callbacks', () => {
  async function approvalWithCard(options: Partial<SentCardOptions> = {}) {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const approval = await createApproval(run.id, {
      toolName: 'browser.submit',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    })
    const card = await sentCard({
      kind: 'approval_request',
      dedupeKey: `browser:approval:${approval.id}`,
      telegramMessageId: 901,
      approvalId: approval.id,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      ...options,
    })
    return { run, approval, card }
  }

  it('approves a pending approval exactly once', async () => {
    const { approval, card } = await approvalWithCard()
    const first = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:ap:${approval.id}`, 901), {
      chatId: CHAT_ID,
      db,
      ...first,
    })
    expect(first.answers).toEqual(['Approved. Submitting now.'])
    const [resolved] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(resolved).toMatchObject({ status: 'approved', resolver: 'telegram' })
    expect(resolved?.resolverRef).toMatch(/^update:\d+$/)
    expect(card.status).toBe('sent')

    const second = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:ap:${approval.id}`, 901), {
      chatId: CHAT_ID,
      db,
      ...second,
    })
    expect(second.answers).toEqual(['This approval was already handled or has expired.'])
    const [again] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(again?.status).toBe('approved')
    expect(again?.resolvedAt?.getTime()).toBe(resolved?.resolvedAt?.getTime())
  })

  it('denies an approval', async () => {
    const { approval } = await approvalWithCard()
    const t = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:no:${approval.id}`, 901), {
      chatId: CHAT_ID,
      db,
      ...t,
    })
    expect(t.answers).toEqual(['Cancelled.'])
    const [resolved] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(resolved).toMatchObject({ status: 'denied', resolver: 'telegram' })
  })

  it('acknowledges a callback from a different message without resolving', async () => {
    const { approval } = await approvalWithCard({ telegramMessageId: 902 })
    const t = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:ap:${approval.id}`, 901), {
      chatId: CHAT_ID,
      db,
      ...t,
    })
    expect(t.answers).toEqual(['This approval message is no longer active.'])
    const [pending] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(pending?.status).toBe('pending')
  })

  it('refuses an approval id that does not match the stored card', async () => {
    const { approval, run } = await approvalWithCard()
    const other = await createApproval(run.id, {
      toolName: 'browser.submit',
      dedupeKey: 'other-approval',
    })
    const t = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:ap:${other.id}`, 901), {
      chatId: CHAT_ID,
      db,
      ...t,
    })
    expect(t.answers).toEqual(['This approval does not match this message.'])
    const [pending] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(pending?.status).toBe('pending')
  })

  it('treats an expired card and an expired approval as stale', async () => {
    const expiredCard = await approvalWithCard({
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 30_000),
    })
    const first = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:ap:${expiredCard.approval.id}`, 901), {
      chatId: CHAT_ID,
      db,
      ...first,
    })
    expect(first.answers).toEqual(['This approval has expired. Send the request again.'])

    const expiredApproval = await approvalWithCard({ telegramMessageId: 903 })
    await db
      .update(approvals)
      .set({
        requestedAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(approvals.id, expiredApproval.approval.id))
    const second = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:ap:${expiredApproval.approval.id}`, 903), {
      chatId: CHAT_ID,
      db,
      ...second,
    })
    expect(second.answers).toEqual(['This approval was already handled or has expired.'])
    const [pending] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, expiredApproval.approval.id))
    expect(pending?.status).toBe('pending')
  })

  it('ignores a card that was never delivered', async () => {
    const { approval, card } = await approvalWithCard()
    await db
      .update(notificationOutbox)
      .set({ status: 'pending', sentAt: null, telegramMessageId: null })
      .where(eq(notificationOutbox.id, card.id))
    const t = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:ap:${approval.id}`, 901), {
      chatId: CHAT_ID,
      db,
      ...t,
    })
    expect(t.answers).toEqual(['This approval message is no longer active.'])
  })
})

describe('bt: stop and retry callbacks', () => {
  it('cancels a queued task with its Stop button and sends a cancellation card', async () => {
    const task = await createBrowserTask({})
    await sentCard({
      dedupeKey: `browser:task:${task.id}:queued`,
      telegramMessageId: 910,
    })
    const t = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:stop:${task.id}`, 910), {
      chatId: CHAT_ID,
      db,
      ...t,
    })
    expect(t.answers).toEqual(['Cancelled.'])
    const [cancelled] = await db.select().from(browserTasks).where(eq(browserTasks.id, task.id))
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      statusReason: 'cancelled_by_user',
    })
    expect(cancelled?.finishedAt).toBeInstanceOf(Date)
    const [card] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.dedupeKey, `browser:task:${task.id}:result`))
    expect(card?.body).toContain('Cancelled. Nothing was submitted.')
  })

  it('acknowledges a Stop for an already finished task and a non-Stop card', async () => {
    const task = await createBrowserTask({})
    await sentCard({
      dedupeKey: `browser:task:${task.id}:queued`,
      telegramMessageId: 911,
    })
    await db
      .update(browserTasks)
      .set({ status: 'failed', finishedAt: new Date(), statusReason: 'interrupted' })
      .where(eq(browserTasks.id, task.id))
    const finished = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:stop:${task.id}`, 911), {
      chatId: CHAT_ID,
      db,
      ...finished,
    })
    expect(finished.answers).toEqual(['This task already finished.'])

    const other = await createBrowserTask({})
    await sentCard({
      dedupeKey: `browser:task:${other.id}:result`,
      telegramMessageId: 912,
    })
    const stale = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:stop:${other.id}`, 912), {
      chatId: CHAT_ID,
      db,
      ...stale,
    })
    expect(stale.answers).toEqual(['This task message is no longer active.'])
  })

  it('retries a finished task as a new linked task and queues it', async () => {
    const original = await createBrowserTask({
      status: 'failed',
      statusReason: 'interrupted',
      finishedAt: new Date(),
    })
    await sentCard({
      dedupeKey: `browser:task:${original.id}:recovered`,
      telegramMessageId: 920,
    })
    const enqueued: { queue: string; data: Record<string, unknown> }[] = []
    const t = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:retry:${original.id}`, 920), {
      chatId: CHAT_ID,
      db,
      ...t,
      enqueue: async (queue, data) => {
        enqueued.push({ queue, data })
      },
    })
    expect(t.answers).toEqual(['Retry queued.'])
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]?.queue).toBe('browser-task')

    const rows = await db.select().from(browserTasks)
    expect(rows).toHaveLength(2)
    const retry = rows.find((row) => row.retryOfTaskId === original.id)
    expect(retry).toMatchObject({
      source: 'retry',
      status: 'queued',
      site: original.site,
      action: original.action,
      targetUrl: original.targetUrl,
    })
    expect(enqueued[0]?.data).toEqual({ taskId: retry?.id })
    const queuedCard = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.dedupeKey, `browser:task:${retry?.id}:queued`))
    expect(queuedCard).toHaveLength(1)

    const second = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:retry:${original.id}`, 920), {
      chatId: CHAT_ID,
      db,
      ...second,
      enqueue: async () => undefined,
    })
    expect(second.answers).toEqual(['This task was already retried.'])
  })

  it('refuses to retry an active task or without an enabled agent', async () => {
    const active = await createBrowserTask({ status: 'running' })
    await sentCard({
      dedupeKey: `browser:task:${active.id}:result`,
      telegramMessageId: 921,
    })
    const busy = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:retry:${active.id}`, 921), {
      chatId: CHAT_ID,
      db,
      ...busy,
      enqueue: async () => undefined,
    })
    expect(busy.answers).toEqual(['Stop the task before retrying it.'])

    const failed = await createBrowserTask({
      status: 'failed',
      finishedAt: new Date(),
    })
    await sentCard({
      dedupeKey: `browser:task:${failed.id}:result`,
      telegramMessageId: 922,
    })
    const disabled = transport()
    await handleTelegramUpdate(callbackUpdate(`bt:retry:${failed.id}`, 922), {
      chatId: CHAT_ID,
      db,
      ...disabled,
    })
    expect(disabled.answers).toEqual(['Browser tasks are not enabled on this worker.'])
  })

  it('answers unknown bt actions without touching mail handlers', async () => {
    const t = transport()
    await handleTelegramUpdate(callbackUpdate('bt:xx:abcd1234-1111-4111-8111-111111111111', 9), {
      chatId: CHAT_ID,
      db,
      ...t,
    })
    expect(t.answers).toEqual(['Unknown browser action.'])
    const [update] = await db
      .select()
      .from(telegramUpdates)
      .where(and(eq(telegramUpdates.kind, 'callback_query')))
    expect(update?.processedAt).toBeInstanceOf(Date)
  })
})
