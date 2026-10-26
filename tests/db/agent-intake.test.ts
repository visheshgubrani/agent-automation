import { eq } from 'drizzle-orm'
import type { Update } from 'grammy/types'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentConfig } from '../../src/config.js'
import {
  browserTasks,
  llmCalls,
  notificationOutbox,
  runs,
  telegramMessages,
} from '../../src/db/schema/index.js'
import { handleAgentIntakeJob } from '../../src/jobs/agent-intake.js'
import { handleBrowserTaskJob } from '../../src/jobs/browser-task.js'
import { logger } from '../../src/logger.js'
import { markSent } from '../../src/notifications/outbox.js'
import { handleBrowserCallback } from '../../src/telegram/browser.js'
import { handleTelegramUpdate } from '../../src/telegram/updates.js'
import { FakeBrowserDriver, FakeBrowserPage, redditThread, THREAD_URL } from '../fakes/browser.js'
import { scriptedModel, textResult, toolCallResult } from '../fakes/model.js'
import { createRun, createTelegramMessage, createUserSettings } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const JOB_ID = '11111111-2222-4333-8444-555555555555'
const REQUEST = 'Post to r/test\nTitle: Exact title\nPlease draft a short body about code review.'
const PLAN = {
  kind: 'one_off',
  site: 'reddit',
  action: 'reddit_post',
  targetUrl: 'https://www.reddit.com/r/test/submit',
  fields: [
    { key: 'post_title', value: 'Exact title', provenance: 'user_verbatim' },
    { key: 'post_body', value: 'A drafted note.', provenance: 'drafted' },
  ],
  cron: null,
  question: null,
}
const agent: AgentConfig = {
  openaiApiKey: 'test-key',
  model: 'gpt-6-luna',
  reasoningEffort: 'medium',
  maxSteps: 10,
  maxOutputTokens: 1_000,
  stepTimeoutMs: 30_000,
  taskMaxUsd: 0.5,
  browser: {
    cdpUrl: 'http://127.0.0.1:9222',
    viewUrl: 'https://box.tail1234.ts.net/',
    artifactDir: '/tmp/intake-test-artifacts',
    handoffTimeoutMinutes: 15,
    approvalTimeoutMinutes: 30,
  },
}
function fakeBoss() {
  const sent: { name: string; data: Record<string, unknown> }[] = []
  return {
    sent,
    boss: {
      send: async (name: string, data: Record<string, unknown>) => {
        sent.push({ name, data })
        return 'job-id'
      },
    } as unknown as PgBoss,
  }
}
async function intake(text = REQUEST, output: unknown = PLAN, payload?: Record<string, unknown>) {
  const message = await createTelegramMessage({ text, ...(payload ? { payload } : {}) })
  const model = scriptedModel([textResult(JSON.stringify(output))])
  const { boss, sent } = fakeBoss()
  const context = { db, jobId: JOB_ID, data: { telegramMessageId: message.id }, boss, agent, model }
  const result = await handleAgentIntakeJob(context)
  return { message, model, sent, context, result }
}
async function draft() {
  const h = await intake(`/comment ${THREAD_URL}\nHello exactly.`, PLAN, {
    message: { date: Math.floor(Date.now() / 1000) - 601 },
  })
  const [task] = await db.select().from(browserTasks)
  const [card] = await db.select().from(notificationOutbox)
  if (!task || !card) throw new Error('missing task or draft card')
  return { ...h, task, card }
}
async function tap(
  h: Awaited<ReturnType<typeof draft>>,
  data: string,
  messageId = 700,
  enqueue: (queue: string, data: Record<string, unknown>) => Promise<void> = async () => undefined,
) {
  const run = await createRun({ kind: 'agent_chat', trigger: 'telegram' })
  const answers: (string | undefined)[] = []
  await handleBrowserCallback(data, messageId, {
    db,
    chatDbId: h.message.chatId,
    runId: run.id,
    updateId: 99,
    log: logger,
    enqueue,
    responder: {
      reply: async () => 1,
      editMessage: async () => undefined,
      answerCallback: async (text) => {
        answers.push(text)
      },
    },
  })
  expect(answers).toHaveLength(1)
  return answers[0]
}

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('free-text and reply intake', () => {
  it('refuses paid intake at the agent budget before creating a task', async () => {
    await createUserSettings({ agentDailyLimitUsd: '0' })
    const h = await intake()
    expect(h.result.outcome).toBe('unclear')
    const [notice] = await db.select().from(notificationOutbox)
    expect(notice?.body).toContain('budget is used up')
    expect(await db.select().from(llmCalls)).toHaveLength(0)
    expect(await db.select().from(browserTasks)).toHaveLength(0)
  })
  it('routes an explicit reply without sending the quoted message or history to the model', async () => {
    const enqueued: Record<string, unknown>[] = []
    const update = {
      update_id: 10,
      message: {
        message_id: 11,
        date: Math.floor(Date.now() / 1000),
        text: REQUEST,
        from: { id: 42, is_bot: false, first_name: 'Tester' },
        chat: { id: 42, type: 'private' },
        reply_to_message: {
          message_id: 9,
          text: 'PRIVATE-QUOTED-CONTENT',
          date: 1,
          chat: { id: 42, type: 'private' },
        },
      },
    } as Update
    await handleTelegramUpdate(update, {
      db,
      chatId: 42,
      reply: async () => 1,
      enqueue: async (name, data) => {
        expect(name).toBe('agent-intake')
        enqueued.push(data)
      },
    })
    const [message] = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.direction, 'inbound'))
    if (!message) throw new Error('missing inbound message')
    expect(message.replyToTelegramMessageId).toBe(9)
    expect(enqueued).toEqual([{ telegramMessageId: message.id }])
    const model = scriptedModel([
      async (params) => {
        expect(JSON.stringify(params.prompt)).not.toContain('PRIVATE-QUOTED-CONTENT')
        expect(params.prompt.filter((message) => message.role === 'user')).toEqual([
          {
            role: 'user',
            content: [{ type: 'text', text: JSON.stringify({ userMessage: REQUEST }) }],
          },
        ])
        expect(params.tools ?? []).toHaveLength(0)
        const [reservation] = await db.select().from(llmCalls)
        expect(reservation).toMatchObject({ purpose: 'agent_intake', status: 'in_flight' })
        return textResult(JSON.stringify(PLAN))
      },
    ])
    await handleAgentIntakeJob({
      db,
      jobId: JOB_ID,
      data: { telegramMessageId: message.id },
      boss: fakeBoss().boss,
      agent,
      model,
    })
    const [call] = await db.select().from(llmCalls)
    expect(call).toMatchObject({ purpose: 'agent_intake', status: 'succeeded' })
    const [task] = await db.select().from(browserTasks)
    expect(task).toMatchObject({
      action: 'reddit_post',
      requestMessageId: message.id,
      status: 'queued',
    })
    expect(task?.spec).toMatchObject({ fields: PLAN.fields })
  })

  it('pins a decision once on intake retry, with one paid call and one task', async () => {
    const h = await intake()
    expect(h.result.outcome).toBe('created')
    expect((await handleAgentIntakeJob(h.context)).outcome).toBe('existing')
    expect(await db.select().from(llmCalls)).toHaveLength(1)
    expect(await db.select().from(browserTasks)).toHaveLength(1)
    expect(await db.select().from(notificationOutbox)).toHaveLength(1)
    const [message] = await db.select().from(telegramMessages)
    expect(message?.payload.browserIntake).toMatchObject({ kind: 'one_off', action: 'reddit_post' })
  })

  it('serializes simultaneous intake attempts for the same message', async () => {
    const message = await createTelegramMessage({ text: REQUEST })
    const model = scriptedModel([textResult(JSON.stringify(PLAN))])
    const context = {
      db,
      jobId: JOB_ID,
      data: { telegramMessageId: message.id },
      boss: fakeBoss().boss,
      agent,
      model,
    }
    const results = await Promise.all([
      handleAgentIntakeJob(context),
      handleAgentIntakeJob(context),
    ])
    expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'existing'])
    expect(await db.select().from(llmCalls)).toHaveLength(1)
    expect(await db.select().from(browserTasks)).toHaveLength(1)
  })

  it('asks for clarification for unclear replies, and never starts a task', async () => {
    const h = await intake('Use that text.', {
      ...PLAN,
      kind: 'unclear',
      question: 'Please include the target and text in this message.',
    })
    expect(h.result.outcome).toBe('unclear')
    await handleAgentIntakeJob(h.context)
    expect(await db.select().from(browserTasks)).toHaveLength(0)
    const notices = await db.select().from(notificationOutbox)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.body).toContain('include the target and text')
    expect(h.sent.some((job) => job.name === 'browser-task')).toBe(false)
  })

  it('rejects a model paraphrase claimed as verbatim', async () => {
    const h = await intake(REQUEST, {
      ...PLAN,
      fields: [{ ...PLAN.fields[0], value: 'Rewritten title' }, PLAN.fields[1]],
    })
    expect(h.result.outcome).toBe('unclear')
    expect(await db.select().from(browserTasks)).toHaveLength(0)
    const [notice] = await db.select().from(notificationOutbox)
    expect(notice?.body).toContain('exactly match')
  })

  it('stores a recurring request as an inert draft without browser work', async () => {
    const h = await intake(`${REQUEST}\nEvery day at 9am`, {
      ...PLAN,
      kind: 'schedule',
      cron: '0 9 * * *',
    })
    expect(h.result.outcome).toBe('schedule')
    await handleAgentIntakeJob(h.context)
    const [message] = await db.select().from(telegramMessages)
    expect(message?.payload.browserScheduleDraft).toMatchObject({
      kind: 'schedule',
      cron: '0 9 * * *',
      timezone: 'Asia/Kolkata',
      instruction: `${REQUEST}\nEvery day at 9am`,
    })
    expect(await db.select().from(browserTasks)).toHaveLength(0)
    const notices = await db.select().from(notificationOutbox)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.body).toContain('will not run or submit anything')
    expect(h.sent.some((job) => job.name === 'browser-task')).toBe(false)
    expect(await db.select().from(llmCalls)).toHaveLength(1)
  })

  it('bounds input before calling a model and sanitizes invalid model output', async () => {
    const h = await intake('x'.repeat(4_001))
    expect(h.result.outcome).toBe('unclear')
    expect(await db.select().from(llmCalls)).toHaveLength(0)
    await handleAgentIntakeJob({
      ...h.context,
      data: { telegramMessageId: (await createTelegramMessage({ text: REQUEST })).id },
      model: scriptedModel([textResult('PRIVATE-BAD-MODEL-OUTPUT')]),
    })
    expect(await db.select().from(browserTasks)).toHaveLength(0)
    const audit = await db.select().from(runs)
    const calls = await db.select().from(llmCalls)
    expect(JSON.stringify([audit, calls])).not.toContain('PRIVATE-BAD-MODEL-OUTPUT')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.status).toBe('succeeded')
  })
})

describe('replay confirmation before browser preparation', () => {
  it('gates an old deterministic command, including accidental job dispatch', async () => {
    const h = await draft()
    expect(h.result.outcome).toBe('draft')
    expect(h.task.statusReason).toBe('confirmation_required')
    expect(h.card.payload).toMatchObject({
      browserTaskDraft: { version: 1, taskId: h.task.id },
      inlineButtons: [
        [
          { text: 'Start', callbackData: `bt:go:${h.task.id}` },
          { text: 'Stop', callbackData: `bt:stop:${h.task.id}` },
        ],
      ],
    })
    expect(h.sent.some((job) => job.name === 'browser-task')).toBe(false)
    const driver = new FakeBrowserDriver(() => new FakeBrowserPage(redditThread()))
    expect(
      await handleBrowserTaskJob({
        db,
        jobId: JOB_ID,
        data: { taskId: h.task.id },
        agent,
        boss: fakeBoss().boss,
        driver,
      }),
    ).toMatchObject({ runOpened: false })
    expect(driver.sessions).toHaveLength(0)
    expect(await db.select().from(llmCalls)).toHaveLength(0)
  })

  it('Start queues once, rejects a replay, and works if the consumer begins before Start commits', async () => {
    const h = await draft()
    await markSent(db, h.card.id, { telegramMessageId: 700 })
    const driver = new FakeBrowserDriver(() => new FakeBrowserPage(redditThread()))
    let consumer: ReturnType<typeof handleBrowserTaskJob> | undefined
    const enqueue = async (_queue: string, data: Record<string, unknown>) => {
      consumer = handleBrowserTaskJob({
        db,
        jobId: JOB_ID,
        data: { taskId: String(data.taskId) },
        agent,
        boss: fakeBoss().boss,
        driver,
        modelFactory: () =>
          scriptedModel([toolCallResult('report_result', { summary: 'checked' })]),
      })
    }
    expect(await tap(h, `bt:go:${h.task.id}`, 700, enqueue)).toContain('Task queued')
    if (!consumer) throw new Error('consumer did not start')
    await consumer
    expect(driver.sessions).toHaveLength(1)
    expect(await tap(h, `bt:go:${h.task.id}`)).toContain('already handled or has expired')
    const [task] = await db.select().from(browserTasks)
    expect(task?.statusReason).not.toBe('confirmation_required')
  })

  it('rejects undelivered/wrong-message/wrong-task/expired Starts', async () => {
    const h = await draft()
    expect(await tap(h, `bt:go:${h.task.id}`)).toContain('already handled or has expired')
    await markSent(db, h.card.id, { telegramMessageId: 700 })
    expect(await tap(h, `bt:go:${h.task.id}`, 701)).toContain('already handled or has expired')
    expect(await tap(h, `bt:go:${h.message.id}`, 700)).toContain('already handled or has expired')
    await db
      .update(notificationOutbox)
      .set({ createdAt: new Date(Date.now() - 3_600_000), expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(notificationOutbox.id, h.card.id))
    expect(await tap(h, `bt:go:${h.task.id}`)).toContain('already handled or has expired')
    expect(await tap(h, `bt:stop:${h.task.id}`)).toContain('no longer active')
    const [task] = await db.select().from(browserTasks)
    expect(task?.statusReason).toBe('confirmation_required')
  })

  it('keeps the gate intact when queueing Start fails, allowing a later tap', async () => {
    const h = await draft()
    await markSent(db, h.card.id, { telegramMessageId: 700 })
    await expect(
      tap(h, `bt:go:${h.task.id}`, 700, async () => {
        throw new Error('queue unavailable')
      }),
    ).rejects.toThrow('queue unavailable')
    const [task] = await db.select().from(browserTasks)
    expect(task?.statusReason).toBe('confirmation_required')
    expect(await tap(h, `bt:go:${h.task.id}`)).toContain('Task queued')
  })

  it('Stop cancels a stale draft without queueing it', async () => {
    const h = await draft()
    await markSent(db, h.card.id, { telegramMessageId: 700 })
    expect(await tap(h, `bt:stop:${h.task.id}`)).toBe('Cancelled.')
    const [task] = await db.select().from(browserTasks)
    expect(task?.status).toBe('cancelled')
    expect(await tap(h, `bt:go:${h.task.id}`)).toContain('already handled or has expired')
  })

  it('gates a free-text request too, and a missing send timestamp cannot bypass confirmation', async () => {
    const h = await intake(REQUEST, PLAN, {})
    expect(h.result.outcome).toBe('draft')
    expect(await db.select().from(llmCalls)).toHaveLength(1)
    expect(h.sent.some((job) => job.name === 'browser-task')).toBe(false)
  })
})
