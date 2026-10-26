import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { and, eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { approveApproval } from '../../src/agent/approvals.js'
import { disableBrowserSchedule, resolveScheduleDraft } from '../../src/agent/schedules.js'
import type { AgentConfig } from '../../src/config.js'
import {
  approvals,
  browserSchedules,
  browserTasks,
  llmCalls,
  notificationOutbox,
} from '../../src/db/schema/index.js'
import { handleAgentIntakeJob } from '../../src/jobs/agent-intake.js'
import { handleBrowserSchedulesJob, requeueBrowserTasks } from '../../src/jobs/browser-schedules.js'
import { handleBrowserTaskJob } from '../../src/jobs/browser-task.js'
import { createBoss, ensureQueues, QUEUES, startBoss, stopBoss } from '../../src/queue.js'
import {
  FakeBrowserDriver,
  FakeBrowserPage,
  redditComposer,
  redditPosted,
} from '../fakes/browser.js'
import { scriptedModel, toolCallResult } from '../fakes/model.js'
import { createBrowserTask, createTelegramMessage } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const SLOT = new Date('2026-10-25T03:30:00Z')
const NOW = new Date('2026-10-25T03:40:00Z')
const JOB_ID = '11111111-2222-4333-8444-555555555555'
const SPEC = {
  version: 1,
  targetUrl: 'https://www.reddit.com/r/test/comments/abc/thread/',
  fields: [{ key: 'comment_text', value: 'Exact scheduled comment.', provenance: 'user_verbatim' }],
}
const PLAN = {
  version: 1,
  kind: 'schedule',
  site: 'reddit',
  action: 'reddit_comment',
  spec: SPEC,
  cron: '0 9 * * *',
  timezone: 'Asia/Kolkata',
}
const dirs: string[] = []
let boss: PgBoss
beforeAll(async () => {
  boss = createBoss(process.env.DATABASE_URL as string, { schedule: false, supervise: false })
  await startBoss(boss)
  await ensureQueues(boss, { agentEnabled: true })
})
beforeEach(async () => {
  await truncateAllTables()
  await boss.deleteQueuedJobs(QUEUES.browserTask.name)
})
afterAll(async () => {
  await stopBoss(boss)
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await closeTestDb()
})
async function schedule(overrides: Partial<typeof browserSchedules.$inferInsert> = {}) {
  const [row] = await db
    .insert(browserSchedules)
    .values({
      cron: '0 * * * *',
      instruction: 'Comment exactly as supplied.',
      site: 'reddit',
      action: 'reddit_comment',
      specTemplate: SPEC,
      nextRunAt: SLOT,
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('missing schedule')
  return row
}
const tick = (now = NOW, client = boss) =>
  handleBrowserSchedulesJob({ db, boss: client, jobId: JOB_ID, now })

async function draft() {
  const message = await createTelegramMessage({
    text: `Every day at 9am comment on ${SPEC.targetUrl}: Exact scheduled comment.`,
    payload: { browserIntake: PLAN },
  })
  await handleAgentIntakeJob({
    db,
    boss,
    jobId: JOB_ID,
    data: { telegramMessageId: message.id },
    now: () => new Date('2026-10-25T03:00:00Z'),
  })
  const [card] = await db.select().from(notificationOutbox)
  if (!card?.expiresAt) throw new Error('missing draft card')
  return { message, card }
}

describe('schedule activation', () => {
  it('creates a complete preview but no schedule/task before Save; Save is concurrent/replay safe', async () => {
    const h = await draft()
    expect(h.card.body).toContain('25 Oct 2026, 09:00')
    expect(h.card.body).toContain('26 Oct 2026, 09:00')
    expect(h.card.body).toContain('27 Oct 2026, 09:00')
    expect(h.card.payload.inlineButtons).toEqual([
      [
        { text: 'Save', callbackData: 'bs:save' },
        { text: 'Cancel', callbackData: 'bs:cancel' },
      ],
    ])
    expect(await db.select().from(browserSchedules)).toHaveLength(0)
    expect(await db.select().from(browserTasks)).toHaveLength(0)
    const results = await Promise.all([
      resolveScheduleDraft(db, {
        messageId: h.message.id,
        save: true,
        expiresAt: h.card.expiresAt as Date,
      }),
      resolveScheduleDraft(db, {
        messageId: h.message.id,
        save: true,
        expiresAt: h.card.expiresAt as Date,
      }),
    ])
    expect(results.map((result) => result.outcome).sort()).toEqual(['saved', 'stale'])
    const [stored] = await db.select().from(browserSchedules)
    expect(stored?.nextRunAt.getTime()).toBeGreaterThan(Date.now())
    expect(stored?.specTemplate).toEqual(SPEC)
    expect(await db.select().from(llmCalls)).toHaveLength(0)
  })
  it('Cancel/expiry cannot activate later, and invalid fast schedules ask for clarification', async () => {
    const h = await draft()
    expect(
      (
        await resolveScheduleDraft(db, {
          messageId: h.message.id,
          save: false,
          expiresAt: h.card.expiresAt as Date,
        })
      ).outcome,
    ).toBe('cancelled')
    expect(
      (
        await resolveScheduleDraft(db, {
          messageId: h.message.id,
          save: true,
          expiresAt: h.card.expiresAt as Date,
        })
      ).outcome,
    ).toBe('stale')
    const old = await createTelegramMessage({ payload: { browserIntake: PLAN } })
    expect(
      (await resolveScheduleDraft(db, { messageId: old.id, save: true, expiresAt: new Date(0) }))
        .outcome,
    ).toBe('stale')
    const fast = await createTelegramMessage({
      payload: { browserIntake: { ...PLAN, cron: '*/5 * * * *' } },
    })
    expect(
      await handleAgentIntakeJob({ db, boss, jobId: JOB_ID, data: { telegramMessageId: fast.id } }),
    ).toMatchObject({ outcome: 'unclear' })
    expect(await db.select().from(browserSchedules)).toHaveLength(0)
  })
})

describe('durable schedule ticks', () => {
  it('two concurrent ticks create one queued task and one real queue job per slot, with approval still unset', async () => {
    const s = await schedule()
    await Promise.all([tick(), tick()])
    const tasks = await db.select().from(browserTasks)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      source: 'schedule',
      status: 'queued',
      scheduleId: s.id,
      scheduledFor: SLOT,
      approvalId: null,
      submittedAt: null,
      spec: SPEC,
    })
    const jobs = await boss.findJobs(QUEUES.browserTask.name, { queued: true })
    expect(
      jobs.filter((job) => (job.data as { taskId?: string }).taskId === tasks[0]?.id),
    ).toHaveLength(1)
    const [updated] = await db.select().from(browserSchedules)
    expect(updated?.nextRunAt.toISOString()).toBe('2026-10-25T04:30:00.000Z')
    expect(updated?.lastRunAt).toEqual(SLOT)
    expect(await db.select().from(llmCalls)).toHaveLength(0)
  })
  it('an error after queue insertion rolls back the queue job, task, notice and cursor together', async () => {
    const s = await schedule()
    const failing = {
      send: async (...args: Parameters<PgBoss['send']>) => {
        await boss.send(...args)
        throw new Error('force transaction rollback')
      },
    } as unknown as PgBoss
    await expect(tick(NOW, failing)).rejects.toThrow('Browser schedule transaction failed')
    expect(await db.select().from(browserTasks)).toHaveLength(0)
    expect(await boss.findJobs(QUEUES.browserTask.name, { queued: true })).toHaveLength(0)
    expect((await db.select().from(browserSchedules))[0]?.nextRunAt).toEqual(s.nextRunAt)
    expect(await db.select().from(notificationOutbox)).toHaveLength(0)
    expect(await tick()).toMatchObject({ created: 1 })
  })
  it('does not issue disabled schedules, while disabling preserves previously queued tasks', async () => {
    const s = await schedule({ enabled: false })
    expect(await tick()).toMatchObject({ runOpened: false })
    await db.update(browserSchedules).set({ enabled: true }).where(eq(browserSchedules.id, s.id))
    await tick()
    expect(await disableBrowserSchedule(db, s.id)).toBe(true)
    expect(await tick(new Date('2026-10-25T05:40:00Z'))).toMatchObject({ runOpened: false })
    expect(await db.select().from(browserTasks)).toHaveLength(1)
  })
  it('skips slots over 30 minutes late once, but admits an occurrence exactly 30 minutes late', async () => {
    await schedule()
    expect(await tick(new Date('2026-10-25T04:00:00Z'))).toMatchObject({ created: 1, skipped: 0 })
    await db.delete(browserTasks)
    await db.update(browserSchedules).set({ nextRunAt: SLOT })
    expect(await tick(new Date('2026-10-25T04:00:00.001Z'))).toMatchObject({
      created: 0,
      skipped: 1,
    })
    expect(await tick(new Date('2026-10-25T04:00:00.001Z'))).toMatchObject({ runOpened: false })
    expect(
      await db.select().from(notificationOutbox).where(eq(notificationOutbox.kind, 'system')),
    ).toHaveLength(2) // queued + missed notice
  })
  it('skips downtime backlog while retaining the latest due occurrence inside the grace window', async () => {
    await schedule({ nextRunAt: new Date('2026-10-01T03:30:00Z') })
    expect(await tick()).toMatchObject({ created: 1, skipped: 1 })
    expect((await db.select().from(browserTasks))[0]?.scheduledFor).toEqual(SLOT)
    expect((await db.select().from(browserSchedules))[0]?.nextRunAt.toISOString()).toBe(
      '2026-10-25T04:30:00.000Z',
    )
  })
  it('schema checks preserve schedule slot identity and deletion history', async () => {
    const s = await schedule()
    await expect(createBrowserTask({ scheduleId: s.id })).rejects.toThrow()
    await expect(createBrowserTask({ scheduledFor: SLOT })).rejects.toThrow()
    await createBrowserTask({ source: 'schedule', scheduleId: s.id, scheduledFor: SLOT })
    await expect(
      createBrowserTask({ source: 'schedule', scheduleId: s.id, scheduledFor: SLOT }),
    ).rejects.toThrow()
    await expect(db.delete(browserSchedules).where(eq(browserSchedules.id, s.id))).rejects.toThrow()
  })
  it('re-enqueues lost queued work at startup, but leaves confirmation-gated drafts inert', async () => {
    const ready = await createBrowserTask()
    await createBrowserTask({ statusReason: 'confirmation_required' })
    expect(await requeueBrowserTasks(db, boss)).toBe(1)
    const jobs = await boss.findJobs(QUEUES.browserTask.name, { queued: true })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.data).toEqual({ taskId: ready.id })
    expect(
      await db
        .select()
        .from(browserTasks)
        .where(and(eq(browserTasks.id, ready.id), eq(browserTasks.status, 'queued'))),
    ).toHaveLength(1)
  })
})

function agentConfig(artifactDir: string): AgentConfig {
  return {
    openaiApiKey: 'test',
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    maxSteps: 10,
    maxOutputTokens: 1000,
    stepTimeoutMs: 30000,
    taskMaxUsd: 0.5,
    browser: {
      cdpUrl: 'http://127.0.0.1:9222',
      viewUrl: 'https://box.tail1234.ts.net/',
      artifactDir,
      handoffTimeoutMinutes: 15,
      approvalTimeoutMinutes: 30,
    },
  }
}

it('a scheduled task waits for exact-text approval before the one deterministic submit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-submit-'))
  dirs.push(dir)
  const now = new Date()
  const slot = new Date(Math.floor((now.getTime() - 60000) / 60000) * 60000)
  const minute = (slot.getUTCMinutes() + 30) % 60
  await schedule({ cron: `${minute} * * * *`, nextRunAt: slot })
  await tick(now)
  const [task] = await db.select().from(browserTasks)
  if (!task) throw new Error('missing scheduled task')
  const comment = SPEC.fields[0].value
  const composer = () => ({
    ...redditComposer({ onComment: () => ({ ...redditPosted(comment), url: SPEC.targetUrl }) }),
    url: SPEC.targetUrl,
  })
  const page = new FakeBrowserPage(composer(), { [SPEC.targetUrl]: composer })
  const driver = new FakeBrowserDriver(() => page)
  const controller = new AbortController()
  const promise = handleBrowserTaskJob({
    db,
    boss,
    jobId: task.bossJobId as string,
    data: { taskId: task.id },
    agent: agentConfig(dir),
    driver,
    signal: controller.signal,
    modelFactory: () =>
      scriptedModel([
        toolCallResult('navigate', { url: SPEC.targetUrl }),
        toolCallResult('fill_field', { ref: '1:e20', fieldKey: 'comment_text' }),
        toolCallResult('snapshot', {}),
        toolCallResult('request_submit_approval', {
          submitRef: '2:e22',
          fieldRefs: { comment_text: '2:e20' },
        }),
      ]),
  })
  try {
    for (let i = 0; i < 400; i++) {
      if ((await db.select().from(approvals)).length) break
      await sleep(10)
    }
    const [approval] = await db.select().from(approvals)
    if (!approval) throw new Error('missing scheduled approval')
    expect(approval.payload.fields).toMatchObject([{ value: comment }])
    expect(page.actions.some((action) => action.type === 'click')).toBe(false)
    expect((await db.select().from(browserTasks))[0]?.status).toBe('awaiting_approval')
    await approveApproval(db, { approvalId: approval.id, resolverRef: 'test' })
    expect(await promise).toMatchObject({ status: 'succeeded' })
    expect(page.actions.filter((action) => action.type === 'click')).toEqual([
      { type: 'click', ref: 'e22' },
    ])
  } finally {
    controller.abort()
    await promise
  }
})

it('a scheduled task delayed in the queue past the grace period skips before opening the browser', async () => {
  const s = await schedule()
  const task = await createBrowserTask({ source: 'schedule', scheduleId: s.id, scheduledFor: SLOT })
  const driver = new FakeBrowserDriver(() => new FakeBrowserPage(redditComposer()))
  expect(
    await handleBrowserTaskJob({
      db,
      boss,
      jobId: JOB_ID,
      data: { taskId: task.id },
      agent: agentConfig('/tmp/unused-schedule'),
      driver,
      now: () => new Date(SLOT.getTime() + 30 * 60000 + 1),
    }),
  ).toMatchObject({ status: 'failed', statusReason: 'schedule_missed' })
  expect(driver.sessions).toHaveLength(0)
  expect(await db.select().from(approvals)).toHaveLength(0)
})
