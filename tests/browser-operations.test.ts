import { eq } from 'drizzle-orm'
import type { Update } from 'grammy/types'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  browserSchedules,
  browserTasks,
  notificationOutbox,
  telegramMessages,
} from '../src/db/schema/index.js'
import { handleAgentIntakeJob } from '../src/jobs/agent-intake.js'
import { markSent } from '../src/notifications/outbox.js'
import { handleTelegramUpdate } from '../src/telegram/updates.js'
import {
  createApproval,
  createBrowserTask,
  createRun,
  createTelegramMessage,
} from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

const CHAT_ID = 42
let updateId = 2000
let messageId = 1000
const SPEC = {
  version: 1,
  targetUrl: 'https://www.reddit.com/r/test/comments/abc/thread/',
  fields: [{ key: 'comment_text', value: 'Exact words.', provenance: 'user_verbatim' }],
}
beforeEach(truncateAllTables)
afterAll(closeTestDb)
function transport() {
  const replies: { id: number; text: string }[] = []
  const answers: (string | undefined)[] = []
  const edits: string[] = []
  return {
    replies,
    answers,
    edits,
    options: {
      db,
      chatId: CHAT_ID,
      enqueue: async () => undefined,
      reply: async (text: string) => {
        const id = ++messageId
        replies.push({ id, text })
        return id
      },
      editMessage: async (_id: number, text: string) => {
        edits.push(text)
      },
      answerCallback: async (text?: string) => {
        answers.push(text)
      },
    },
  }
}
async function command(text: string, h: ReturnType<typeof transport>) {
  const update = {
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      date: Math.floor(Date.now() / 1000),
      text,
      chat: { id: CHAT_ID, type: 'private' },
      from: { id: CHAT_ID, is_bot: false, first_name: 'Tester' },
    },
  } as Update
  await handleTelegramUpdate(update, h.options)
}
async function tap(data: string, id: number, h: ReturnType<typeof transport>) {
  const update = {
    update_id: ++updateId,
    callback_query: {
      id: `callback-${updateId}`,
      chat_instance: 'test',
      data,
      from: { id: CHAT_ID, is_bot: false, first_name: 'Tester' },
      message: { message_id: id, date: 1, chat: { id: CHAT_ID, type: 'private' }, text: 'card' },
    },
  } as Update
  await handleTelegramUpdate(update, h.options)
  return h.answers.at(-1)
}
async function scheduleDraft() {
  // The existing fixture uses a distinct chat; callback routing still uses the single allowed chat.
  const message = await createTelegramMessage({
    text: 'Every day at 9am comment exactly.',
    payload: {
      browserIntake: {
        version: 1,
        kind: 'schedule',
        site: 'reddit',
        action: 'reddit_comment',
        spec: SPEC,
        cron: '0 9 * * *',
        timezone: 'Asia/Kolkata',
      },
    },
  })
  await handleAgentIntakeJob({
    db,
    boss: { send: async () => 'queued' } as unknown as PgBoss,
    jobId: '11111111-2222-4333-8444-555555555555',
    data: { telegramMessageId: message.id },
  })
  const [card] = await db.select().from(notificationOutbox)
  if (!card) throw new Error('missing draft')
  return { message, card }
}

describe('schedule callbacks', () => {
  it('requires the delivered matching card, then saves once and rejects a replay', async () => {
    const h = transport()
    const { card } = await scheduleDraft()
    const id = ++messageId
    expect(await tap('bs:save', id, h)).toContain('already handled or has expired')
    await markSent(db, card.id, { telegramMessageId: id })
    expect(await tap('bs:save', id + 10, h)).toContain('already handled or has expired')
    expect(await tap('bs:save', id, h)).toContain('Schedule saved')
    expect(await tap('bs:save', id, h)).toContain('already handled or has expired')
    expect(await db.select().from(browserSchedules)).toHaveLength(1)
    expect(await db.select().from(browserTasks)).toHaveLength(0)
  })
  it('rejects expired and cancelled drafts without creating a schedule', async () => {
    const h = transport()
    const { card } = await scheduleDraft()
    const id = ++messageId
    await markSent(db, card.id, { telegramMessageId: id })
    expect(await tap('bs:cancel', id, h)).toContain('cancelled')
    expect(await tap('bs:save', id, h)).toContain('already handled or has expired')
    expect(await db.select().from(browserSchedules)).toHaveLength(0)
    await db
      .update(notificationOutbox)
      .set({ createdAt: new Date(Date.now() - 3600_000), expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(notificationOutbox.id, card.id))
    expect(await tap('bs:cancel', id, h)).toContain('already handled or has expired')
  })
  it('lists schedules with validated Disable controls and leaves queued tasks intact', async () => {
    const { card } = await scheduleDraft()
    const h = transport()
    const id = ++messageId
    await markSent(db, card.id, { telegramMessageId: id })
    await tap('bs:save', id, h)
    const [schedule] = await db.select().from(browserSchedules)
    if (!schedule) throw new Error('missing schedule')
    const task = await createBrowserTask({
      source: 'schedule',
      scheduleId: schedule.id,
      scheduledFor: new Date(),
    })
    await command('/schedules', h)
    const list = h.replies.at(-1)
    if (!list) throw new Error('missing list')
    expect(list.text).toContain('enabled')
    expect(await tap(`bs:off:${schedule.id}`, list.id + 1, h)).toContain('stale')
    expect(await tap(`bs:off:${schedule.id}`, list.id, h)).toContain('Disabled future runs')
    expect((await db.select().from(browserSchedules))[0]?.enabled).toBe(false)
    expect(
      (await db.select().from(browserTasks).where(eq(browserTasks.id, task.id)))[0]?.status,
    ).toBe('queued')
    expect(h.edits.at(-1)).toContain('disabled')
    expect(await tap(`bs:off:${schedule.id}`, list.id, h)).toContain('already disabled')
  })
})

describe('task commands and list callbacks', () => {
  it('paginates bounded lists and binds Stop to task ids in the current stored page', async () => {
    const tasks = []
    for (let i = 0; i < 6; i++)
      tasks.push(
        await createBrowserTask({
          instruction: 'PRIVATE-TASK-INSTRUCTIONS',
          createdAt: new Date(Date.now() + i),
        }),
      )
    const h = transport()
    await command('/tasks', h)
    const reply = h.replies.at(-1)
    if (!reply) throw new Error('missing list')
    expect(reply.text).not.toContain('PRIVATE-TASK-INSTRUCTIONS')
    const [stored] = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.telegramMessageId, reply.id))
    const meta = stored?.payload.browserTaskList as { ids: string[] }
    expect(meta.ids).toHaveLength(5)
    const omitted = tasks.find((task) => !meta.ids.includes(task.id))
    if (!omitted || !meta.ids[0]) throw new Error('missing tasks')
    expect(await tap(`bt:stop:${omitted.id}`, reply.id, h)).toContain('no longer active')
    expect(await tap(`bt:stop:${meta.ids[0]}`, reply.id, h)).toBe('Cancelled.')
    expect(await tap('bt:list:5', reply.id, h)).toBeUndefined()
    expect(await tap(`bt:stop:${meta.ids[1]}`, reply.id, h)).toContain('no longer active')
    expect(await tap('bt:list:10', reply.id + 1, h)).toContain('stale')
  })
  it('/stop cancels an awaiting approval and its approval row', async () => {
    const approval = await createApproval((await createRun()).id)
    const task = await createBrowserTask({ status: 'awaiting_approval', approvalId: approval.id })
    const h = transport()
    await command('/stop', h)
    expect(h.replies.at(-1)?.text).toContain('Cancelled the active task')
    expect(
      (await db.select().from(browserTasks).where(eq(browserTasks.id, task.id)))[0]?.status,
    ).toBe('cancelled')
  })
  it('/stop requests a running agent to stop, but never interrupts a submit already executing', async () => {
    const task = await createBrowserTask({ status: 'running' })
    const h = transport()
    await command('/stop', h)
    expect(h.replies.at(-1)?.text).toContain('Stopping the active task')
    expect((await db.select().from(browserTasks))[0]?.cancelRequestedAt).toBeInstanceOf(Date)
    await db
      .update(browserTasks)
      .set({ status: 'executing', cancelRequestedAt: null })
      .where(eq(browserTasks.id, task.id))
    await command('/stop', h)
    expect(h.replies.at(-1)?.text).toContain('already executing')
    expect((await db.select().from(browserTasks))[0]?.cancelRequestedAt).toBeNull()
  })
  it('an expired task list cannot stop a task, and /stop does not silently cancel queued work', async () => {
    const task = await createBrowserTask()
    const h = transport()
    await command('/tasks', h)
    const reply = h.replies.at(-1)
    if (!reply) throw new Error('missing list')
    const [stored] = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.telegramMessageId, reply.id))
    if (!stored) throw new Error('missing stored list')
    await db
      .update(telegramMessages)
      .set({
        payload: {
          browserTaskList: {
            ...(stored.payload.browserTaskList as object),
            expiresAt: new Date(0).toISOString(),
          },
        },
      })
      .where(eq(telegramMessages.id, stored.id))
    expect(await tap(`bt:stop:${task.id}`, reply.id, h)).toContain('no longer active')
    await command('/stop', h)
    expect(h.replies.at(-1)?.text).toContain('No active browser task')
    expect((await db.select().from(browserTasks))[0]?.status).toBe('queued')
  })
})
