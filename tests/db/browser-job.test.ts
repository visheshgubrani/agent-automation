import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { asc, eq } from 'drizzle-orm'
import type { Update } from 'grammy/types'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadArtifactPhoto } from '../../src/browser/artifacts.js'
import type { FrameObservation } from '../../src/browser/driver.js'
import type { AgentConfig } from '../../src/config.js'
import {
  approvals,
  browserTasks,
  llmCalls,
  notificationOutbox,
  runs,
  toolCalls,
} from '../../src/db/schema/index.js'
import { handleAgentIntakeJob } from '../../src/jobs/agent-intake.js'
import { handleBrowserTaskJob } from '../../src/jobs/browser-task.js'
import { createBudgetedModel } from '../../src/llm/budgeted-model.js'
import { dispatchPendingNotifications } from '../../src/notifications/dispatcher.js'
import type { TelegramSender } from '../../src/telegram/sender.js'
import { handleTelegramUpdate } from '../../src/telegram/updates.js'
import {
  FakeBrowserDriver,
  FakeBrowserPage,
  type FakePageModel,
  redditComposer,
  redditPosted,
  redditThread,
  THREAD_URL,
} from '../fakes/browser.js'
import { scriptedModel, toolCallResult } from '../fakes/model.js'
import { createBrowserTask, createRun, createTelegramMessage } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const JOB_ID = '11111111-2222-4333-8444-555555555555'
const BROWSER_JOB_ID = '66666666-7777-4888-8999-000000000000'
const CHAT_ID = 42
const COMMENT = 'Exact words, with "quotes", an emoji 🙂 and a newline\nsecond line.'

const tempDirs: string[] = []
beforeEach(truncateAllTables)
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await closeTestDb()
})

async function agentConfig(): Promise<AgentConfig> {
  const artifactDir = await mkdtemp(join(tmpdir(), 'browser-job-'))
  tempDirs.push(artifactDir)
  return {
    openaiApiKey: 'test-key',
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    maxSteps: 10,
    maxOutputTokens: 500,
    stepTimeoutMs: 30_000,
    taskMaxUsd: 0.05,
    browser: {
      cdpUrl: 'http://127.0.0.1:9222',
      viewUrl: 'https://box.tail1234.ts.net/',
      artifactDir,
      handoffTimeoutMinutes: 15,
      approvalTimeoutMinutes: 30,
    },
  }
}

function fakeBoss() {
  const sent: { name: string; data: Record<string, unknown> }[] = []
  const boss = {
    send: async (name: string, data: Record<string, unknown>) => {
      sent.push({ name, data })
      return `job-${sent.length}`
    },
  }
  return { sent, boss: boss as unknown as PgBoss }
}

function senderStub() {
  const texts: { text: string; buttons?: unknown }[] = []
  const photos: { caption: string; bytes: Uint8Array }[] = []
  const sender: TelegramSender = {
    chatId: CHAT_ID,
    send: async (text, options) => {
      texts.push({ text, ...(options?.buttons ? { buttons: options.buttons } : {}) })
      return { messageId: 5_000 + texts.length }
    },
    sendPhoto: async (photo, caption) => {
      photos.push({ caption, bytes: photo })
      return { messageId: 7_000 + photos.length }
    },
  }
  return { texts, photos, sender }
}

async function dispatch(sender: TelegramSender, artifactDir?: string): Promise<void> {
  await dispatchPendingNotifications({
    db,
    sender,
    ...(artifactDir !== undefined
      ? { loadPhoto: (photo) => loadArtifactPhoto(db, artifactDir, photo) }
      : {}),
  })
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(25)
  }
  throw new Error('condition was not met before the timeout')
}

async function outboxByKey(dedupeKey: string) {
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.dedupeKey, dedupeKey))
  if (!row) throw new Error(`outbox row ${dedupeKey} is missing`)
  return row
}

function callbackUpdate(data: string, messageId: number): Update {
  return {
    update_id: 900 + messageId,
    callback_query: {
      id: `callback-${messageId}`,
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

function fakeTransport() {
  const answers: (string | undefined)[] = []
  return {
    answers,
    reply: async () => 1_001,
    editMessage: async () => undefined,
    answerCallback: async (text?: string) => {
      answers.push(text)
    },
  }
}

interface FlowOptions {
  tamperOnSecondRead?: boolean
  frames?: FrameObservation[]
  framesAfterApproval?: FrameObservation[]
}

interface FlowResult {
  task: typeof browserTasks.$inferSelect
  approval: typeof approvals.$inferSelect
  page: FakeBrowserPage
  driver: FakeBrowserDriver
  jobResult: Awaited<ReturnType<typeof handleBrowserTaskJob>>
  approvalCard: typeof notificationOutbox.$inferSelect
}

/** Stored decisions from before D055 must still execute their original exact text. */
async function legacyCommentMessage() {
  return createTelegramMessage({
    text: `/comment ${THREAD_URL}\n${COMMENT}`,
    payload: {
      message: { date: Math.floor(Date.now() / 1000) },
      browserIntake: {
        version: 1,
        kind: 'one_off',
        site: 'reddit',
        action: 'reddit_comment',
        spec: {
          version: 1,
          targetUrl: THREAD_URL,
          fields: [{ key: 'comment_text', value: COMMENT, provenance: 'user_verbatim' }],
        },
      },
    },
  })
}

/** Full path: intake → queued card → job → approval card → Telegram callback → execution. */
async function runCommentFlow(options: FlowOptions = {}): Promise<FlowResult> {
  const config = await agentConfig()
  const message = await legacyCommentMessage()
  const { boss, sent } = fakeBoss()
  await handleAgentIntakeJob({
    jobId: JOB_ID,
    data: { telegramMessageId: message.id },
    boss,
  })
  expect(sent.map((job) => job.name)).toEqual(['browser-task', 'notification-dispatch'])

  const [queued] = await db.select().from(browserTasks)
  if (!queued) throw new Error('intake did not create a task')

  // The Queued card is delivered before the job starts, as it would be in the worker.
  const firstTick = senderStub()
  await dispatch(firstTick.sender)
  expect((await outboxByKey(`browser:task:${queued.id}:queued`)).status).toBe('sent')

  let reads = 0
  const makeThread = (): FakePageModel => {
    const thread = { ...redditThread(), ...(options.frames ? { frames: options.frames } : {}) }
    thread.onClick = {
      e8: () => ({
        ...redditComposer({
          onComment: () => redditPosted(COMMENT),
          ...(options.tamperOnSecondRead
            ? {
                readBack: (_ref: string, stored: string | undefined) => {
                  reads += 1
                  return reads >= 2 ? `${stored ?? ''} (edited)` : (stored ?? '')
                },
              }
            : {}),
        }),
        ...(options.frames ? { frames: options.frames } : {}),
      }),
    }
    return thread
  }
  const page = new FakeBrowserPage(makeThread(), { [THREAD_URL]: makeThread })
  const driver = new FakeBrowserDriver(() => page)
  const steps = [
    toolCallResult('navigate', { url: THREAD_URL }),
    toolCallResult('click', { ref: '1:e8' }),
    toolCallResult('fill_field', { ref: '2:e20', fieldKey: 'comment_text' }),
    toolCallResult('snapshot', {}),
    toolCallResult('request_submit_approval', {
      submitRef: '3:e22',
      fieldRefs: { comment_text: '3:e20' },
    }),
  ]
  const modelFactory = (runId: string) =>
    createBudgetedModel(scriptedModel(steps), {
      db,
      runId,
      purpose: 'agent_browser_step',
      model: 'gpt-6-luna',
      maxOutputTokens: 500,
      taskMaxUsd: 0.05,
    })

  const jobPromise = handleBrowserTaskJob({
    jobId: BROWSER_JOB_ID,
    data: { taskId: queued.id },
    agent: config,
    boss,
    driver,
    modelFactory,
  })

  // Approve from Telegram exactly as the user would: the approval card is delivered, then the
  // callback arrives with that message id.
  await waitFor(async () => (await db.select().from(approvals)).length === 1)
  const [approval] = await db.select().from(approvals)
  if (!approval) throw new Error('job did not create an approval')

  const secondTick = senderStub()
  await dispatch(secondTick.sender)
  const approvalCard = await outboxByKey(`browser:approval:${queued.id}`)
  expect(approvalCard.status).toBe('sent')
  if (approvalCard.telegramMessageId === null) throw new Error('approval card was not delivered')

  if (options.framesAfterApproval) page.model.frames = options.framesAfterApproval
  const transport = fakeTransport()
  await handleTelegramUpdate(
    callbackUpdate(`bt:ap:${approval.id}`, approvalCard.telegramMessageId),
    {
      chatId: CHAT_ID,
      db,
      ...transport,
    },
  )
  expect(transport.answers).toEqual(['Approved. Submitting now.'])

  const jobResult = await jobPromise

  const [task] = await db.select().from(browserTasks).where(eq(browserTasks.id, queued.id))
  if (!task) throw new Error('task row vanished')
  const [resolved] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
  if (!resolved) throw new Error('approval row vanished')
  return { task, approval: resolved, page, driver, jobResult, approvalCard }
}

describe('agent intake', () => {
  it('creates one queued task, the browser-task job, and the Queued card, idempotently', async () => {
    const message = await createTelegramMessage({ text: `/comment ${THREAD_URL}\n${COMMENT}` })
    const { boss, sent } = fakeBoss()

    const first = await handleAgentIntakeJob({
      jobId: JOB_ID,
      data: { telegramMessageId: message.id },
      boss,
    })
    expect(first).toMatchObject({ runOpened: true, outcome: 'created' })

    const [task] = await db.select().from(browserTasks)
    expect(task).toMatchObject({
      status: 'queued',
      source: 'telegram',
      site: 'reddit',
      action: 'reddit_comment',
      targetUrl: THREAD_URL,
      requestMessageId: message.id,
    })
    expect(task?.spec).toEqual({
      version: 1,
      targetUrl: THREAD_URL,
      fields: [],
      composeComment: { thoughts: COMMENT, priorRunIds: [] },
    })
    expect(sent.map((job) => job.name)).toEqual(['browser-task', 'notification-dispatch'])
    expect(sent[0]?.data).toEqual({ taskId: task?.id })

    const card = await outboxByKey(`browser:task:${task?.id}:queued`)
    expect(card.kind).toBe('system')
    expect(card.deliveryPolicy).toBe('at_most_once')
    expect(card.body).toContain('Task #')
    expect(card.payload).toEqual({
      inlineButtons: [[{ text: 'Stop', callbackData: `bt:stop:${task?.id}` }]],
    })

    const retried = await handleAgentIntakeJob({
      jobId: JOB_ID,
      data: { telegramMessageId: message.id },
      boss,
    })
    expect(retried.outcome).toBe('existing')
    expect(await db.select().from(browserTasks)).toHaveLength(1)
    expect(await db.select().from(notificationOutbox)).toHaveLength(1)
  })

  it('answers an invalid command with usage and creates no task', async () => {
    const message = await createTelegramMessage({ text: '/comment not-a-url' })
    const { boss } = fakeBoss()

    const result = await handleAgentIntakeJob({
      jobId: JOB_ID,
      data: { telegramMessageId: message.id },
      boss,
    })
    expect(result.outcome).toBe('invalid')
    expect(await db.select().from(browserTasks)).toHaveLength(0)
    const [notice] = await db.select().from(notificationOutbox)
    expect(notice?.body).toContain('Usage: /comment <reddit thread url>')
  })
})

describe('browser task end to end', () => {
  it('prepares the comment, waits for approval, clicks once, verifies, and sends the result', async () => {
    const flow = await runCommentFlow()

    expect(flow.jobResult).toMatchObject({ runOpened: true, status: 'succeeded' })
    expect(flow.task.status).toBe('succeeded')
    expect(flow.task.statusReason).toBeNull()
    expect(flow.task.submittedAt).toBeInstanceOf(Date)
    expect(flow.task.finishedAt).toBeInstanceOf(Date)
    expect(flow.task.result).toMatchObject({ version: 1, evidenceUrl: THREAD_URL })
    expect(flow.driver.disconnects).toBe(1)

    // Exactly one click on the submit control, by the executor, after approval.
    expect(flow.page.actions.filter((a) => a.type === 'click' && a.ref === 'e22')).toHaveLength(1)
    expect(flow.approval.status).toBe('approved')
    expect(flow.approval.resolver).toBe('telegram')
    expect(flow.approval.resolverRef).toMatch(/^update:\d+$/)

    const [taskRun] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, flow.task.runId ?? ''))
    expect(taskRun).toMatchObject({
      kind: 'browser_task',
      trigger: 'telegram',
      status: 'succeeded',
    })
    const executionRuns = (await db.select().from(runs)).filter(
      (run) => run.kind === 'approval_execution',
    )
    expect(executionRuns).toHaveLength(1)
    expect(executionRuns[0]?.parentRunId).toBe(flow.task.runId)

    const sendCalls = await db.select().from(toolCalls).where(eq(toolCalls.riskTier, 'send'))
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]).toMatchObject({
      toolName: 'browser.submit',
      status: 'succeeded',
      approvalId: flow.approval.id,
    })

    const calls = await db.select().from(llmCalls).orderBy(asc(llmCalls.createdAt))
    expect(calls).toHaveLength(5)
    expect(calls.every((call) => call.purpose === 'agent_browser_step')).toBe(true)
    expect(calls.every((call) => call.status === 'succeeded')).toBe(true)

    // The approval card carries the exact payload values and the screenshot.
    expect(flow.approvalCard.body).toContain(`Comment (verbatim):\n${COMMENT}`)
    expect(flow.approvalCard.body).toContain(`Target: ${THREAD_URL}`)
    expect(flow.approvalCard.kind).toBe('approval_request')
    expect(flow.approvalCard.approvalId).toBe(flow.approval.id)
    const payloadPhoto = (flow.approvalCard.payload as { photo?: { sha256: string } }).photo
    expect(payloadPhoto?.sha256).toMatch(/^[0-9a-f]{64}$/)

    // The result card is committed but not sent by the job; the dispatcher delivers it.
    const resultCard = await outboxByKey(`browser:task:${flow.task.id}:result`)
    expect(resultCard.status).toBe('pending')
    expect(resultCard.body).toContain('Succeeded.')
    expect(resultCard.body).toContain(`Link: ${THREAD_URL}`)
  })

  it('background reCAPTCHA anchors and hidden challenge frames do not block approved execution', async () => {
    const flow = await runCommentFlow({
      frames: [
        { url: 'https://www.google.com/recaptcha/api2/anchor?size=invisible', visible: true },
        { url: 'https://www.google.com/recaptcha/api2/bframe', visible: false },
      ],
    })
    expect(flow.jobResult.status).toBe('succeeded')
    expect(flow.approval.payload.fields).toMatchObject([{ value: COMMENT }])
    expect(
      flow.page.actions.filter((action) => action.type === 'click' && action.ref === 'e22'),
    ).toHaveLength(1)
  })

  it.each([true, null])(
    'a challenge becoming visible or uninspectable after approval prevents the click (%s)',
    async (visible) => {
      const url = 'https://www.google.com/recaptcha/api2/bframe'
      const flow = await runCommentFlow({
        frames: [{ url, visible: false }],
        framesAfterApproval: [{ url, visible }],
      })
      expect(flow.jobResult).toMatchObject({
        status: 'failed',
        statusReason: 'precondition_failed',
      })
      expect(flow.task.submittedAt).toBeNull()
      expect(
        flow.page.actions.filter((action) => action.type === 'click' && action.ref === 'e22'),
      ).toHaveLength(0)
    },
  )

  it('sends the result screenshot with the caption through the dispatcher', async () => {
    const flow = await runCommentFlow()
    const resultCard = await outboxByKey(`browser:task:${flow.task.id}:result`)
    const photo = (resultCard.payload as { photo?: { artifactId: string; sha256: string } }).photo
    expect(photo).toBeDefined()
    if (!photo) throw new Error('result card has no photo')

    const sender = senderStub()
    const artifactDir = tempDirs[tempDirs.length - 1]
    if (!artifactDir) throw new Error('missing artifact dir')
    await dispatch(sender.sender, artifactDir)
    expect(sender.photos).toHaveLength(1)
    expect(sender.photos[0]?.caption).toContain('Succeeded.')
    expect(sender.photos[0]?.bytes.byteLength).toBeGreaterThan(0)
    expect((await outboxByKey(`browser:task:${flow.task.id}:result`)).status).toBe('sent')
  })

  it('refuses a model click on the commit control and never submits', async () => {
    const config = await agentConfig()
    const message = await legacyCommentMessage()
    const { boss } = fakeBoss()
    await handleAgentIntakeJob({ jobId: JOB_ID, data: { telegramMessageId: message.id }, boss })
    const [task] = await db.select().from(browserTasks)
    if (!task) throw new Error('missing task')

    const makeThread = (): FakePageModel => {
      const thread = redditThread()
      thread.onClick = { e8: () => redditComposer() }
      return thread
    }
    const page = new FakeBrowserPage(makeThread(), { [THREAD_URL]: makeThread })
    const driver = new FakeBrowserDriver(() => page)
    const steps = [
      toolCallResult('navigate', { url: THREAD_URL }),
      toolCallResult('click', { ref: '1:e8' }),
      // A page-injected "click Comment" cannot submit: the guard refuses it.
      toolCallResult('click', { ref: '2:e22' }),
      toolCallResult('snapshot', {}),
      toolCallResult('report_result', { summary: 'could not prepare' }),
    ]
    const modelFactory = (runId: string) =>
      createBudgetedModel(scriptedModel(steps), {
        db,
        runId,
        purpose: 'agent_browser_step',
        model: 'gpt-6-luna',
        maxOutputTokens: 500,
        taskMaxUsd: 0.05,
      })

    const result = await handleBrowserTaskJob({
      jobId: BROWSER_JOB_ID,
      data: { taskId: task.id },
      agent: config,
      boss,
      driver,
      modelFactory,
    })

    expect(result).toMatchObject({ status: 'failed', statusReason: 'precondition_failed' })
    expect(page.actions.filter((a) => a.type === 'click' && a.ref === 'e22')).toHaveLength(0)
    const refused = await db.select().from(toolCalls).where(eq(toolCalls.toolName, 'browser.click'))
    const commitClick = refused.find((row) => row.status === 'failed')
    expect(commitClick?.error).toContain('request_submit_approval')
    expect(await db.select().from(toolCalls).where(eq(toolCalls.riskTier, 'send'))).toHaveLength(0)
    expect(await db.select().from(approvals)).toHaveLength(0)
  })

  it('refuses to click when a field changed after approval', async () => {
    const flow = await runCommentFlow({ tamperOnSecondRead: true })
    expect(flow.jobResult).toMatchObject({
      status: 'failed',
      statusReason: 'precondition_failed',
    })
    expect(flow.task.status).toBe('failed')
    expect(flow.task.statusReason).toBe('precondition_failed')
    expect(flow.task.submittedAt).toBeNull()
    expect(flow.page.actions.filter((a) => a.type === 'click' && a.ref === 'e22')).toHaveLength(0)
  })

  it('fails a task at the daily cap without opening the browser', async () => {
    const config = await agentConfig()
    for (let index = 0; index < 10; index += 1) {
      await createBrowserTask({
        status: 'succeeded',
        submittedAt: new Date(),
        finishedAt: new Date(),
      })
    }
    const queued = await createBrowserTask({})
    const { boss } = fakeBoss()
    const driver = new FakeBrowserDriver(() => new FakeBrowserPage(redditThread()))

    const result = await handleBrowserTaskJob({
      jobId: BROWSER_JOB_ID,
      data: { taskId: queued.id },
      agent: config,
      boss,
      driver,
      modelFactory: () => {
        throw new Error('the model must not run at the daily cap')
      },
    })

    expect(result).toMatchObject({ status: 'failed', statusReason: 'daily_cap' })
    expect(driver.sessions).toHaveLength(0)
    const [task] = await db.select().from(browserTasks).where(eq(browserTasks.id, queued.id))
    expect(task).toMatchObject({ status: 'failed', statusReason: 'daily_cap' })
    expect(task?.submittedAt).toBeNull()
    const card = await outboxByKey(`browser:task:${queued.id}:result`)
    expect(card.body).toContain('Daily cap reached')
    expect(card.body).toContain('Nothing was submitted')
  })

  it('refuses a second active task while another task holds the slot', async () => {
    const config = await agentConfig()
    const active = await createBrowserTask({})
    const waiting = await createBrowserTask({})
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })

    const { claimTaskSlot } = await import('../../src/agent/tasks.js')
    expect(await claimTaskSlot(db, { taskId: active.id, runId: run.id })).toBe('claimed')

    const { boss } = fakeBoss()
    const driver = new FakeBrowserDriver(() => new FakeBrowserPage(redditThread()))
    const result = await handleBrowserTaskJob({
      jobId: BROWSER_JOB_ID,
      data: { taskId: waiting.id },
      agent: config,
      boss,
      driver,
      modelFactory: () => {
        throw new Error('no model for a busy task')
      },
    })

    expect(result).toMatchObject({ status: 'failed', statusReason: 'interrupted' })
    expect(driver.sessions).toHaveLength(0)
    const [stillQueued] = await db
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, waiting.id))
    expect(stillQueued?.status).toBe('failed')
    // The unique partial index also refuses a second active row.
    await expect(createBrowserTask({ status: 'running', runId: run.id })).rejects.toThrow()
  })

  it('interrupts an approval wait on shutdown and sends a Retry notice', async () => {
    const config = await agentConfig()
    const message = await legacyCommentMessage()
    const { boss } = fakeBoss()
    await handleAgentIntakeJob({ jobId: JOB_ID, data: { telegramMessageId: message.id }, boss })
    const [task] = await db.select().from(browserTasks)
    if (!task) throw new Error('missing task')

    const makeThread = (): FakePageModel => {
      const thread = redditThread()
      thread.onClick = { e8: () => redditComposer() }
      return thread
    }
    const page = new FakeBrowserPage(makeThread(), { [THREAD_URL]: makeThread })
    const controller = new AbortController()
    const steps = [
      toolCallResult('navigate', { url: THREAD_URL }),
      toolCallResult('click', { ref: '1:e8' }),
      toolCallResult('fill_field', { ref: '2:e20', fieldKey: 'comment_text' }),
      toolCallResult('snapshot', {}),
      toolCallResult('request_submit_approval', {
        submitRef: '3:e22',
        fieldRefs: { comment_text: '3:e20' },
      }),
    ]
    const modelFactory = (runId: string) =>
      createBudgetedModel(scriptedModel(steps), {
        db,
        runId,
        purpose: 'agent_browser_step',
        model: 'gpt-6-luna',
        maxOutputTokens: 500,
        taskMaxUsd: 0.05,
      })

    const jobPromise = handleBrowserTaskJob({
      jobId: BROWSER_JOB_ID,
      data: { taskId: task.id },
      agent: config,
      boss,
      driver: new FakeBrowserDriver(() => page),
      modelFactory,
      signal: controller.signal,
    })

    await waitFor(async () => (await db.select().from(approvals)).length === 1)
    controller.abort()
    const result = await jobPromise

    expect(result).toMatchObject({ status: 'failed', statusReason: 'interrupted' })
    const [finished] = await db.select().from(browserTasks).where(eq(browserTasks.id, task.id))
    expect(finished).toMatchObject({ status: 'failed', statusReason: 'interrupted' })
    expect(finished?.finishedAt).toBeInstanceOf(Date)
    const [approval] = await db.select().from(approvals)
    expect(approval).toMatchObject({ status: 'expired', resolver: 'system' })
    const notice = await outboxByKey(`browser:task:${task.id}:recovered`)
    expect(notice.body).toContain('worker restart')
    expect(notice.payload).toEqual({
      inlineButtons: [[{ text: 'Retry', callbackData: `bt:retry:${task.id}` }]],
    })
    expect(page.actions.filter((a) => a.type === 'click' && a.ref === 'e22')).toHaveLength(0)
  })
})
