import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { recoverBrowserTasks } from '../../src/agent/recovery.js'
import {
  approvals,
  artifacts,
  browserHandoffs,
  browserTasks,
  notificationOutbox,
  toolCalls,
} from '../../src/db/schema/index.js'
import { createLogger } from '../../src/logger.js'
import {
  createApproval,
  createArtifact,
  createBrowserHandoff,
  createBrowserTask,
  createRun,
} from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const VIEW_URL = 'https://box.tail1234.ts.net/'
const log = createLogger({ level: 'error', pretty: false })

beforeEach(truncateAllTables)
afterAll(closeTestDb)

async function outboxByKey(dedupeKey: string) {
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.dedupeKey, dedupeKey))
  return row
}

function recover(now?: Date) {
  return recoverBrowserTasks({ db, log, viewUrl: VIEW_URL, ...(now ? { now } : {}) })
}

describe('browser task startup recovery', () => {
  it('fails an awaiting-approval task, expires its approval, interrupts the handoff, and sends Retry', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'running', runId: run.id })
    const approval = await createApproval(run.id, { toolName: 'browser.submit' })
    await db
      .update(browserTasks)
      .set({ status: 'awaiting_approval', approvalId: approval.id })
      .where(eq(browserTasks.id, task.id))
    const handoff = await createBrowserHandoff(task.id, run.id, { reason: 'login' })

    const counts = await recover()

    expect(counts).toMatchObject({
      interrupted: 1,
      approvalsExpired: 1,
      handoffsInterrupted: 1,
      notices: 1,
    })
    const [finished] = await db.select().from(browserTasks).where(eq(browserTasks.id, task.id))
    expect(finished).toMatchObject({
      status: 'failed',
      statusReason: 'interrupted',
      submittedAt: null,
    })
    expect(finished?.finishedAt).toBeInstanceOf(Date)
    const [expired] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(expired).toMatchObject({ status: 'expired', resolver: 'system' })
    expect(expired?.resolvedAt).toBeInstanceOf(Date)
    const [interrupted] = await db
      .select()
      .from(browserHandoffs)
      .where(eq(browserHandoffs.id, handoff.id))
    expect(interrupted).toMatchObject({ status: 'interrupted' })
    expect(interrupted?.resolvedAt).toBeInstanceOf(Date)

    const notice = await outboxByKey(`browser:task:${task.id}:recovered`)
    expect(notice?.body).toContain('worker restart')
    expect(notice?.body).toContain('Nothing was submitted')
    expect(notice?.payload).toEqual({
      inlineButtons: [[{ text: 'Retry', callbackData: `bt:retry:${task.id}` }]],
    })
  })

  it('fails a running task with no approval and still sends one Retry notice', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'running', runId: run.id })

    const counts = await recover()
    expect(counts.interrupted).toBe(1)
    const [finished] = await db.select().from(browserTasks).where(eq(browserTasks.id, task.id))
    expect(finished).toMatchObject({ status: 'failed', statusReason: 'interrupted' })
    expect(await outboxByKey(`browser:task:${task.id}:recovered`)).toBeDefined()
  })

  it('marks an in-flight send unknown and the task outcome_unknown with Open browser', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'executing', runId: run.id })
    const approval = await createApproval(run.id, {
      toolName: 'browser.submit',
      status: 'approved',
      resolvedAt: new Date(),
      resolver: 'telegram',
    })
    await db
      .update(browserTasks)
      .set({ approvalId: approval.id })
      .where(eq(browserTasks.id, task.id))
    const [send] = await db
      .insert(toolCalls)
      .values({
        runId: run.id,
        toolName: 'browser.submit',
        riskTier: 'send',
        status: 'running',
        args: {},
        approvalId: approval.id,
      })
      .returning()
    if (!send) throw new Error('missing tool call')

    const counts = await recover()
    expect(counts.outcomeUnknown).toBe(1)
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.id, send.id))
    expect(call?.status).toBe('unknown')
    expect(call?.finishedAt).toBeInstanceOf(Date)

    const [finished] = await db.select().from(browserTasks).where(eq(browserTasks.id, task.id))
    expect(finished).toMatchObject({ status: 'outcome_unknown', statusReason: null })
    expect(finished?.submittedAt).toBeInstanceOf(Date)

    const notice = await outboxByKey(`browser:task:${task.id}:recovered`)
    expect(notice?.body).toContain('outcome is unknown')
    expect(notice?.payload).toEqual({
      inlineButtons: [
        [{ text: 'Retry', callbackData: `bt:retry:${task.id}` }],
        [{ text: 'Open browser', url: VIEW_URL }],
      ],
    })
    expect(await db.select().from(approvals)).toHaveLength(1)
  })

  it('passes a finished send outcome to the task: succeeded becomes unverified', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'executing', runId: run.id })
    const approval = await createApproval(run.id, { toolName: 'browser.submit' })
    await db
      .update(browserTasks)
      .set({ approvalId: approval.id })
      .where(eq(browserTasks.id, task.id))
    await db.insert(toolCalls).values({
      runId: run.id,
      toolName: 'browser.submit',
      riskTier: 'send',
      status: 'succeeded',
      args: {},
      approvalId: approval.id,
      startedAt: new Date(Date.now() - 1_000),
      finishedAt: new Date(),
    })

    const counts = await recover()
    expect(counts.unverified).toBe(1)
    const [finished] = await db.select().from(browserTasks).where(eq(browserTasks.id, task.id))
    expect(finished).toMatchObject({ status: 'unverified' })
    expect(finished?.submittedAt).toBeInstanceOf(Date)
    const notice = await outboxByKey(`browser:task:${task.id}:recovered`)
    expect(notice?.body).toContain('could not be verified')
    expect(notice?.payload).toEqual({
      inlineButtons: [[{ text: 'Retry', callbackData: `bt:retry:${task.id}` }]],
    })
  })

  it('fails an executing task with no send call and keeps the consumed approval', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'executing', runId: run.id })
    const approval = await createApproval(run.id, {
      toolName: 'browser.submit',
      status: 'approved',
      resolvedAt: new Date(),
      resolver: 'telegram',
    })
    await db
      .update(browserTasks)
      .set({ approvalId: approval.id })
      .where(eq(browserTasks.id, task.id))

    const counts = await recover()
    expect(counts.interrupted).toBe(1)
    const [finished] = await db.select().from(browserTasks).where(eq(browserTasks.id, task.id))
    expect(finished).toMatchObject({ status: 'failed', statusReason: 'interrupted' })
    const [stillApproved] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(stillApproved?.status).toBe('approved')
  })

  it('never touches queued tasks and is idempotent across runs', async () => {
    const queued = await createBrowserTask({})
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const active = await createBrowserTask({ status: 'running', runId: run.id })
    await createArtifact({ taskId: active.id })

    await recover()
    await recover()

    const rows = await db.select().from(browserTasks)
    expect(rows.find((row) => row.id === queued.id)?.status).toBe('queued')
    expect(rows.find((row) => row.id === active.id)?.status).toBe('failed')
    const notices = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.dedupeKey, `browser:task:${active.id}:recovered`))
    expect(notices).toHaveLength(1)
    expect(await db.select().from(artifacts)).toHaveLength(1)
  })
})
