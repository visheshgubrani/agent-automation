import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { asc, eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { approveApproval } from '../../src/agent/approvals.js'
import { completeHandoff, createHandoff, waitForHandoff } from '../../src/agent/handoffs.js'
import { handoffButtons } from '../../src/agent/render.js'
import { loadArtifactPhoto } from '../../src/browser/artifacts.js'
import type { AgentConfig } from '../../src/config.js'
import {
  approvals,
  browserHandoffs,
  browserTasks,
  llmCalls,
  notificationOutbox,
  toolCalls,
} from '../../src/db/schema/index.js'
import { handleBrowserTaskJob } from '../../src/jobs/browser-task.js'
import { createBudgetedModel } from '../../src/llm/budgeted-model.js'
import { logger } from '../../src/logger.js'
import { dispatchPendingNotifications } from '../../src/notifications/dispatcher.js'
import { claimNextDue, markSent, recoverStaleSending } from '../../src/notifications/outbox.js'
import { handleBrowserCallback } from '../../src/telegram/browser.js'
import {
  challengePage,
  FakeBrowserDriver,
  FakeBrowserPage,
  redditComposer,
  redditPosted,
  redditThread,
  THREAD_URL,
} from '../fakes/browser.js'
import { type ScriptStep, scriptedModel, toolCallResult } from '../fakes/model.js'
import { createArtifact, createBrowserTask, createRun, createTelegramChat } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const dirs: string[] = []
const VIEW_URL = 'https://box.tail1234.ts.net/'
beforeEach(truncateAllTables)
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await closeTestDb()
})

async function taskRow(id: string) {
  const [task] = await db.select().from(browserTasks).where(eq(browserTasks.id, id))
  return task
}
async function handoffs() {
  return db.select().from(browserHandoffs).orderBy(asc(browserHandoffs.requestedAt))
}
async function waitUntil(check: () => Promise<boolean>) {
  for (let n = 0; n < 400; n++) {
    if (await check()) return
    await sleep(20)
  }
  throw new Error('condition timed out')
}
async function callback(data: string, messageId: number) {
  const chat = await createTelegramChat()
  const run = await createRun({ kind: 'agent_chat', trigger: 'telegram' })
  const answers: string[] = []
  await handleBrowserCallback(data, messageId, {
    db,
    chatDbId: chat.id,
    runId: run.id,
    updateId: 99,
    log: logger,
    viewUrl: VIEW_URL,
    responder: {
      reply: async () => undefined,
      editMessage: async () => undefined,
      answerCallback: async (text) => {
        if (text) answers.push(text)
      },
    },
  })
  expect(answers).toHaveLength(1)
  return answers[0]
}
async function deliver(handoff: typeof browserHandoffs.$inferSelect, messageId: number) {
  if (!handoff.notificationId) throw new Error('missing handoff card')
  await markSent(db, handoff.notificationId, { telegramMessageId: messageId })
}

async function startJob(
  options: {
    manual?: boolean
    steps?: ScriptStep[]
    stepTimeoutMs?: number
    now?: () => Date
  } = {},
) {
  const artifactDir = await mkdtemp(join(tmpdir(), 'handoff-job-'))
  dirs.push(artifactDir)
  const config: AgentConfig = {
    openaiApiKey: 'test-key',
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    maxSteps: 20,
    maxOutputTokens: 500,
    stepTimeoutMs: options.stepTimeoutMs ?? 30_000,
    taskMaxUsd: 0.5,
    browser: {
      cdpUrl: 'http://127.0.0.1:9222',
      viewUrl: VIEW_URL,
      artifactDir,
      handoffTimeoutMinutes: 15,
      approvalTimeoutMinutes: 30,
    },
  }
  const task = await createBrowserTask({
    targetUrl: THREAD_URL,
    spec: {
      version: 1,
      targetUrl: THREAD_URL,
      fields: [{ key: 'comment_text', value: 'hello', provenance: 'user_verbatim' }],
    },
  })
  const page = new FakeBrowserPage(redditThread(), {
    [THREAD_URL]: options.manual ? redditThread : challengePage,
  })
  const driver = new FakeBrowserDriver(() => page)
  const controller = new AbortController()
  const mock = scriptedModel([
    toolCallResult('navigate', { url: THREAD_URL }),
    ...(options.manual
      ? [toolCallResult('request_human', { reason: 'other', detail: 'Please check the page' })]
      : []),
    ...(options.steps ?? [toolCallResult('report_result', { summary: 'finished checking' })]),
  ])
  const promise = handleBrowserTaskJob({
    db,
    jobId: '11111111-2222-4333-8444-555555555555',
    data: { taskId: task.id },
    agent: config,
    boss: { send: async () => 'nudge' } as unknown as PgBoss,
    driver,
    signal: controller.signal,
    ...(options.now ? { now: options.now } : {}),
    modelFactory: (runId) =>
      createBudgetedModel(mock, {
        db,
        runId,
        purpose: 'agent_browser_step',
        model: 'gpt-6-luna',
        maxOutputTokens: 500,
        taskMaxUsd: 0.5,
      }),
  })
  await waitUntil(async () => (await handoffs()).length === 1)
  const first = (await handoffs())[0]
  if (!first) throw new Error('no handoff')
  return { promise, controller, driver, page, task, first, config }
}

async function pausedTask() {
  const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
  const task = await createBrowserTask({ status: 'running', runId: run.id })
  const artifact = await createArtifact({ taskId: task.id })
  const now = new Date()
  const created = await createHandoff(db, {
    taskId: task.id,
    runId: run.id,
    reason: 'login',
    detail: 'login required',
    pageUrl: THREAD_URL,
    screenshotArtifactId: artifact.id,
    viewUrl: VIEW_URL,
    now,
    expiresAt: new Date(now.getTime() + 60_000),
  })
  if (created.outcome !== 'created') throw new Error('no handoff')
  return { task, handoff: created.handoff, now }
}

describe('human handoff lifecycle', () => {
  it('atomically writes the task pause, screenshot card, phone URL, and at-least-once policy', async () => {
    const { task, handoff } = await pausedTask()
    expect((await taskRow(task.id))?.status).toBe('waiting_for_human')
    const [card] = await db.select().from(notificationOutbox)
    expect(card).toMatchObject({
      id: handoff.notificationId,
      kind: 'system',
      deliveryPolicy: 'at_least_once',
    })
    expect(card?.body).toContain(`Open browser: ${VIEW_URL}`)
    expect(card?.body).toContain(`Page: ${THREAD_URL}`)
    expect(card?.payload?.photo).toMatchObject({ artifactId: handoff.screenshotArtifactId })
    expect(card?.payload?.inlineButtons).toEqual(handoffButtons(task.id, handoff.id, VIEW_URL))
    // An uncertain delivery is retried under the snapshotted policy, using the same handoff.
    await claimNextDue(db)
    await sleep(5)
    const recovered = await recoverStaleSending(db, { staleAfterMs: 0 })
    expect(recovered).toEqual({ quarantined: 0, requeued: 1 })
    const delivered: string[] = []
    await dispatchPendingNotifications({
      db,
      sender: {
        chatId: 42,
        send: async (text) => {
          delivered.push(text)
          return { messageId: 840 }
        },
        sendPhoto: async () => {
          throw new Error('text fallback expected')
        },
      },
    })
    expect(delivered).toEqual([card?.body])
    expect(await callback(`bt:done:${handoff.id}`, 840)).toContain('Checking the page')
    expect(await callback(`bt:done:${handoff.id}`, 840)).toContain('already handled or has expired')
    expect(await handoffs()).toHaveLength(1)
  })

  it('rejects wrong-message, mismatched, undelivered, expired, and replayed Done', async () => {
    const { handoff, task } = await pausedTask()
    const data = `bt:done:${handoff.id}`
    expect(await callback(data, 800)).toContain('already handled or has expired')
    await deliver(handoff, 801)
    expect(await callback(data, 802)).toContain('already handled or has expired')
    expect(await callback(`bt:done:${task.id}`, 801)).toContain('already handled or has expired')
    expect(
      await completeHandoff(db, {
        handoffId: handoff.id,
        notificationId: handoff.notificationId ?? 'missing',
        resolverRef: 'late',
        now: handoff.expiresAt,
      }),
    ).toBe(false)
    expect(await callback(data, 801)).toBe('Done. Checking the page again.')
    expect(await callback(data, 801)).toContain('already handled or has expired')
    expect((await handoffs())[0]).toMatchObject({ status: 'resolved', resolverRef: 'update:99' })
    expect(await waitForHandoff({ db, taskId: task.id, handoffId: handoff.id })).toBe('resolved')
    expect((await taskRow(task.id))?.status).toBe('running')
  })

  it('times out and atomically closes the handoff and task', async () => {
    const { handoff, task } = await pausedTask()
    expect(
      await waitForHandoff({
        db,
        taskId: task.id,
        handoffId: handoff.id,
        now: () => handoff.expiresAt,
      }),
    ).toBe('timed_out')
    expect((await handoffs())[0]).toMatchObject({
      status: 'timed_out',
      resolvedAt: handoff.expiresAt,
    })
    expect(await taskRow(task.id)).toMatchObject({
      status: 'failed',
      statusReason: 'handoff_timeout',
    })
    expect(await callback(`bt:done:${handoff.id}`, 801)).toContain('already handled or has expired')
  })
})

describe('browser job handoffs', () => {
  it('rechecks after Done and reaches approval and a single verified submit after a long wait', async () => {
    const h = await startJob({
      stepTimeoutMs: 100,
      steps: [
        toolCallResult('click', { ref: '2:e8' }),
        toolCallResult('fill_field', { ref: '3:e20', fieldKey: 'comment_text' }),
        toolCallResult('snapshot', {}),
        toolCallResult('request_submit_approval', {
          submitRef: '4:e22',
          fieldRefs: { comment_text: '4:e20' },
        }),
      ],
    })
    try {
      await sleep(150) // Longer than the model deadline; the handoff must keep the page held.
      expect((await taskRow(h.task.id))?.status).toBe('waiting_for_human')
      expect(await db.select().from(llmCalls)).toHaveLength(1)
      const photos: Uint8Array[] = []
      await dispatchPendingNotifications({
        db,
        sender: {
          chatId: 42,
          send: async () => ({ messageId: 800 }),
          sendPhoto: async (photo) => {
            photos.push(photo)
            return { messageId: 800 }
          },
        },
        loadPhoto: (photo) => loadArtifactPhoto(db, h.config.browser.artifactDir, photo),
      })
      expect(photos).toHaveLength(1)
      const thread = redditThread()
      thread.onClick = { e8: () => redditComposer({ onComment: () => redditPosted('hello') }) }
      h.page.setModel(thread)
      expect(await callback(`bt:done:${h.first.id}`, 800)).toContain('Checking the page')
      await waitUntil(async () => (await db.select().from(approvals)).length === 1)
      const [approval] = await db.select().from(approvals)
      expect((await taskRow(h.task.id))?.status).toBe('awaiting_approval')
      if (!approval) throw new Error('missing approval')
      await approveApproval(db, { approvalId: approval.id, resolverRef: 'test' })
      expect(await h.promise).toMatchObject({ status: 'succeeded' })
      expect(h.page.actions.filter((a) => a.type === 'click' && a.ref === 'e22')).toHaveLength(1)
      expect(h.driver.disconnects).toBe(1)
    } finally {
      h.controller.abort()
      await h.promise
    }
  })

  it('asks again when Done is still blocked, then fails at three handoffs without another model call', async () => {
    const h = await startJob()
    try {
      for (let i = 0; i < 3; i++) {
        await waitUntil(async () => (await handoffs()).length === i + 1)
        const handoff = (await handoffs())[i]
        if (!handoff) throw new Error('missing handoff')
        await deliver(handoff, 810 + i)
        expect(await callback(`bt:done:${handoff.id}`, 810 + i)).toContain('Checking the page')
      }
      expect(await h.promise).toMatchObject({ status: 'failed', statusReason: 'handoff_limit' })
      expect(await handoffs()).toHaveLength(3)
      expect((await handoffs()).every((handoff) => handoff.status === 'resolved')).toBe(true)
      expect(await db.select().from(llmCalls)).toHaveLength(1)
      expect(await db.select().from(approvals)).toHaveLength(0)
      expect(h.page.actions.some((a) => a.type === 'click')).toBe(false)
    } finally {
      h.controller.abort()
      await h.promise
    }
  })

  it('re-snapshots and reruns detectors after an explicit request_human', async () => {
    const h = await startJob({ manual: true })
    try {
      await deliver(h.first, 820)
      h.page.setModel(challengePage())
      await callback(`bt:done:${h.first.id}`, 820)
      await waitUntil(async () => (await handoffs()).length === 2)
      const second = (await handoffs())[1]
      if (!second) throw new Error('missing second handoff')
      expect(second.reason).toBe('verification')
      // The old Done and Stop cannot resolve/cancel the new handoff.
      expect(await callback(`bt:done:${h.first.id}`, 820)).toContain(
        'already handled or has expired',
      )
      expect(await callback(`bt:stop:${h.task.id}`, 820)).toContain('no longer active')
      expect((await taskRow(h.task.id))?.status).toBe('waiting_for_human')
      expect(await db.select().from(llmCalls)).toHaveLength(2)
    } finally {
      h.controller.abort()
      await h.promise
    }
  })

  it('Stop closes a waiting handoff and cancels without a submit or another model call', async () => {
    const h = await startJob()
    try {
      await deliver(h.first, 830)
      expect(await callback(`bt:stop:${h.task.id}`, 830)).toBe('Cancelled.')
      expect(await h.promise).toMatchObject({
        status: 'cancelled',
        statusReason: 'cancelled_by_user',
      })
      expect((await handoffs())[0]).toMatchObject({ status: 'cancelled', resolverRef: 'update:99' })
      expect(await db.select().from(approvals)).toHaveLength(0)
      expect(await db.select().from(llmCalls)).toHaveLength(1)
    } finally {
      h.controller.abort()
      await h.promise
    }
  })

  it('shutdown interrupts the wait, frees the browser, and keeps a result notice for restart', async () => {
    const h = await startJob()
    h.controller.abort()
    expect(await h.promise).toMatchObject({ status: 'failed', statusReason: 'interrupted' })
    await waitUntil(async () => (await handoffs())[0]?.status === 'interrupted')
    expect(await taskRow(h.task.id)).toMatchObject({
      status: 'failed',
      statusReason: 'interrupted',
    })
    expect(h.driver.disconnects).toBe(1)
    const notices = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.dedupeKey, `browser:task:${h.task.id}:result`))
    expect(notices).toHaveLength(1)
    expect(notices[0]?.status).toBe('pending')
    expect(await db.select().from(toolCalls).where(eq(toolCalls.riskTier, 'send'))).toHaveLength(0)
  })

  it('a handoff timeout ends the job with handoff_timeout and a result notice', async () => {
    let current = new Date()
    const h = await startJob({ now: () => current })
    try {
      current = h.first.expiresAt
      expect(await h.promise).toMatchObject({ status: 'failed', statusReason: 'handoff_timeout' })
      const [notice] = await db
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.dedupeKey, `browser:task:${h.task.id}:result`))
      expect(notice?.body).toContain('timed out')
      expect((await handoffs())[0]?.status).toBe('timed_out')
    } finally {
      h.controller.abort()
      await h.promise
    }
  })
})
