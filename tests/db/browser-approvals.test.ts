import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createSubmitApproval, expireApproval, waitForApproval } from '../../src/agent/approvals.js'
import type { BrowserSubmitApprovalPayloadV1 } from '../../src/agent/contracts.js'
import { requestTaskCancel } from '../../src/agent/tasks.js'
import { approvals, browserTasks, notificationOutbox } from '../../src/db/schema/index.js'
import { THREAD_URL } from '../fakes/browser.js'
import { createApproval, createBrowserTask, createRun } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const TASK_ID = 'abcd1234-1111-4111-8111-111111111111'

function payload(taskId: string): BrowserSubmitApprovalPayloadV1 {
  return {
    version: 1,
    taskId,
    site: 'reddit',
    action: 'reddit_comment',
    targetUrl: THREAD_URL,
    pageUrl: THREAD_URL,
    fields: [
      {
        key: 'comment_text',
        label: 'Comment',
        role: 'textbox',
        name: 'Comment',
        value: 'exact text',
        provenance: 'user_verbatim',
      },
    ],
    submit: { role: 'button', name: 'Comment' },
    screenshot: { artifactId: TASK_ID, sha256: 'b'.repeat(64) },
    preparedAt: new Date().toISOString(),
  }
}

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('createSubmitApproval', () => {
  it('writes the approval, the task status, and the card in one transaction', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'running', runId: run.id })
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 60_000)

    const created = await createSubmitApproval(db, {
      task,
      runId: run.id,
      payload: payload(task.id),
      expiresAt,
      now,
    })
    expect(created).toBeDefined()

    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, created?.approval.id ?? ''))
    expect(approval).toMatchObject({
      runId: run.id,
      toolName: 'browser.submit',
      riskTier: 'send',
      status: 'pending',
      dedupeKey: `browser:approval:${task.id}`,
      retryOfApprovalId: null,
    })
    expect(approval?.payload).toMatchObject({ taskId: task.id, version: 1 })

    const [updated] = await db.select().from(browserTasks).where(eq(browserTasks.id, task.id))
    expect(updated).toMatchObject({ status: 'awaiting_approval', approvalId: approval?.id })

    const [card] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.dedupeKey, `browser:approval:${task.id}`))
    expect(card).toMatchObject({
      kind: 'approval_request',
      approvalId: approval?.id,
      deliveryPolicy: 'at_least_once',
    })
    expect(card?.body).toContain('Comment (verbatim):\nexact text')
    expect(card?.payload).toMatchObject({
      photo: { artifactId: TASK_ID, sha256: 'b'.repeat(64) },
    })

    // A second request cannot run: the task left `running`.
    const second = await createSubmitApproval(db, {
      task,
      runId: run.id,
      payload: payload(task.id),
      expiresAt,
      now,
    })
    expect(second).toBeUndefined()
  })

  it('links a retry approval to the original approval', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const original = await createBrowserTask({ status: 'running', runId: run.id })
    const originalApproval = await createApproval(run.id, { toolName: 'browser.submit' })
    await db
      .update(browserTasks)
      .set({ status: 'failed', finishedAt: new Date(), approvalId: originalApproval.id })
      .where(eq(browserTasks.id, original.id))

    const retry = await createBrowserTask({
      source: 'retry',
      retryOfTaskId: original.id,
      status: 'running',
      runId: run.id,
    })
    const now = new Date()
    const created = await createSubmitApproval(db, {
      task: retry,
      runId: run.id,
      payload: payload(retry.id),
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    })
    expect(created?.approval.retryOfApprovalId).toBe(originalApproval.id)
  })
})

describe('waitForApproval', () => {
  it('resolves an approval decision', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'awaiting_approval', runId: run.id })
    const approval = await createApproval(run.id, {
      toolName: 'browser.submit',
      status: 'approved',
      resolvedAt: new Date(),
      resolver: 'telegram',
    })
    const outcome = await waitForApproval({
      db,
      taskId: task.id,
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      pollMs: 10,
    })
    expect(outcome).toBe('approved')
  })

  it('expires a pending approval at the deadline', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'awaiting_approval', runId: run.id })
    const now = Date.now()
    const approval = await createApproval(run.id, {
      toolName: 'browser.submit',
      requestedAt: new Date(now - 1_000),
      expiresAt: new Date(now + 80),
    })

    const outcome = await waitForApproval({
      db,
      taskId: task.id,
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      pollMs: 10,
    })

    expect(outcome).toBe('expired')
    const [expired] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(expired).toMatchObject({ status: 'expired', resolver: 'system' })
    expect(expired?.resolvedAt).toBeInstanceOf(Date)
    // A second expiry is a no-op; the conditional update is consumed once.
    expect(await expireApproval(db, { approvalId: approval.id })).toBeUndefined()
  })

  it('stops when the task asks to cancel', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'awaiting_approval', runId: run.id })
    const approval = await createApproval(run.id, { toolName: 'browser.submit' })
    await db
      .update(browserTasks)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(browserTasks.id, task.id))

    const outcome = await waitForApproval({
      db,
      taskId: task.id,
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      pollMs: 10,
    })
    expect(outcome).toBe('cancel_requested')
    const [pending] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(pending?.status).toBe('pending')
  })

  it('stops on shutdown without resolving anything', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ status: 'awaiting_approval', runId: run.id })
    const approval = await createApproval(run.id, { toolName: 'browser.submit' })
    const controller = new AbortController()
    controller.abort()

    const outcome = await waitForApproval({
      db,
      taskId: task.id,
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      pollMs: 10,
      signal: controller.signal,
    })
    expect(outcome).toBe('interrupted')
    const [pending] = await db.select().from(approvals).where(eq(approvals.id, approval.id))
    expect(pending?.status).toBe('pending')
  })
})

describe('requestTaskCancel', () => {
  it('asks a running task to stop and never aborts an executing submit', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const running = await createBrowserTask({ status: 'running', runId: run.id })
    expect(await requestTaskCancel(db, { taskId: running.id })).toBe('requested')
    const [asked] = await db.select().from(browserTasks).where(eq(browserTasks.id, running.id))
    expect(asked?.cancelRequestedAt).toBeInstanceOf(Date)
    expect(asked?.status).toBe('running')

    // Free the single active slot; a started submit is never aborted by a Stop.
    await db
      .update(browserTasks)
      .set({ status: 'failed', statusReason: 'cancelled_by_user', finishedAt: new Date() })
      .where(eq(browserTasks.id, running.id))
    const executing = await createBrowserTask({ status: 'executing', runId: run.id })
    expect(await requestTaskCancel(db, { taskId: executing.id })).toBe('requested')
    const [stillExecuting] = await db
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, executing.id))
    expect(stillExecuting?.status).toBe('executing')

    const finished = await createBrowserTask({ status: 'failed', finishedAt: new Date() })
    expect(await requestTaskCancel(db, { taskId: finished.id })).toBe('finished')
    expect(await requestTaskCancel(db, { taskId: TASK_ID })).toBe('not_found')
  })
})
