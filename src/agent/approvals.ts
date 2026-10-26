/**
 * Browser submit approvals (phase 05, D008/D042). Creation writes the approval, the
 * `approval_request` outbox row, and the task's `awaiting_approval` status in one transaction.
 * The approval payload is the immutable execution contract; execution claims it exactly once.
 */
import { and, eq, gt } from 'drizzle-orm'
import type { Db, DbSession } from '../db/index.js'
import type { approvalResolver } from '../db/schema/enums.js'
import { approvals, type BrowserTaskRow, browserTasks } from '../db/schema/index.js'
import { enqueueNotification } from '../notifications/outbox.js'
import { BROWSER_TASK_OPEN_STATUSES, type BrowserSubmitApprovalPayloadV1 } from './contracts.js'
import { approvalButtons, renderApprovalCard, shortTaskId, taskLabels } from './render.js'

export const BROWSER_SUBMIT_TOOL_NAME = 'browser.submit'

/** One `approvals` row; `payload` is the immutable execution contract. */
export type BrowserApprovalRow = typeof approvals.$inferSelect

/** Poll interval for the bounded approval page hold. */
export const APPROVAL_POLL_MS = 1_000

export function approvalDedupeKey(taskId: string): string {
  return `browser:approval:${taskId}`
}

export interface CreateSubmitApprovalInput {
  task: BrowserTaskRow
  /** The browser_task run the approval belongs to. */
  runId: string
  payload: BrowserSubmitApprovalPayloadV1
  expiresAt: Date
  now: Date
}

export interface CreatedApproval {
  approval: BrowserApprovalRow
  notificationId: string
}

/**
 * Create the approval, move the task to `awaiting_approval`, and enqueue the card atomically.
 * Returns undefined when the task is no longer running (for example a Stop raced the request),
 * in which case nothing is written. A retry task links its new approval to the old one.
 */
export async function createSubmitApproval(
  db: Db,
  input: CreateSubmitApprovalInput,
): Promise<CreatedApproval | undefined> {
  const { task, payload, now } = input
  const { siteLabel, actionLabel } = taskLabels(payload.site, payload.action)

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, task.id))
      .for('update')
      .limit(1)
    if (current?.status !== 'running') return undefined

    let retryOfApprovalId: string | undefined
    if (current.retryOfTaskId) {
      const [original] = await tx
        .select({ approvalId: browserTasks.approvalId })
        .from(browserTasks)
        .where(eq(browserTasks.id, current.retryOfTaskId))
        .limit(1)
      if (original?.approvalId) retryOfApprovalId = original.approvalId
    }

    const [approval] = await tx
      .insert(approvals)
      .values({
        runId: input.runId,
        toolName: BROWSER_SUBMIT_TOOL_NAME,
        riskTier: 'send',
        summary: `${siteLabel} ${actionLabel} #${shortTaskId(task.id)}`,
        payload: payload as unknown as Record<string, unknown>,
        dedupeKey: approvalDedupeKey(task.id),
        status: 'pending',
        requestedAt: now,
        expiresAt: input.expiresAt,
        ...(retryOfApprovalId !== undefined ? { retryOfApprovalId } : {}),
      })
      .returning()
    if (!approval) throw new Error('createSubmitApproval did not return a row')

    await tx
      .update(browserTasks)
      .set({ status: 'awaiting_approval', approvalId: approval.id, updatedAt: now })
      .where(and(eq(browserTasks.id, task.id), eq(browserTasks.status, 'running')))

    const { notification } = await enqueueNotification(tx, {
      kind: 'approval_request',
      dedupeKey: approvalDedupeKey(task.id),
      body: renderApprovalCard(payload, { expiresAt: input.expiresAt }),
      payload: {
        photo: payload.screenshot,
        inlineButtons: approvalButtons(approval.id),
      },
      approvalId: approval.id,
      runId: input.runId,
      expiresAt: input.expiresAt,
    })

    return { approval, notificationId: notification.id }
  })
}

export type ApprovalResolution = 'approved' | 'denied' | 'expired' | 'cancelled'
export type ApprovalResolver = (typeof approvalResolver.enumValues)[number]

interface ResolveApprovalInput {
  approvalId: string
  status: ApprovalResolution
  resolver: ApprovalResolver
  resolverRef?: string
  now?: Date
  /** Approve/deny require the row to still be unexpired; cancel/expire do not. */
  requireUnexpired?: boolean
}

/** Conditional resolution; undefined means the row was already resolved or had expired. */
async function resolveApproval(
  db: DbSession,
  input: ResolveApprovalInput,
): Promise<BrowserApprovalRow | undefined> {
  const now = input.now ?? new Date()
  const conditions = [eq(approvals.id, input.approvalId), eq(approvals.status, 'pending')]
  if (input.requireUnexpired) conditions.push(gt(approvals.expiresAt, now))

  const [row] = await db
    .update(approvals)
    .set({
      status: input.status,
      resolvedAt: now,
      resolver: input.resolver,
      resolverRef: input.resolverRef ?? null,
      updatedAt: now,
    })
    .where(and(...conditions))
    .returning()
  return row
}

export function approveApproval(
  db: DbSession,
  options: { approvalId: string; resolverRef?: string; now?: Date },
): Promise<BrowserApprovalRow | undefined> {
  return resolveApproval(db, {
    approvalId: options.approvalId,
    status: 'approved',
    resolver: 'telegram',
    ...(options.resolverRef !== undefined ? { resolverRef: options.resolverRef } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    requireUnexpired: true,
  })
}

export function denyApproval(
  db: DbSession,
  options: { approvalId: string; resolverRef?: string; now?: Date },
): Promise<BrowserApprovalRow | undefined> {
  return resolveApproval(db, {
    approvalId: options.approvalId,
    status: 'denied',
    resolver: 'telegram',
    ...(options.resolverRef !== undefined ? { resolverRef: options.resolverRef } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    requireUnexpired: true,
  })
}

export function cancelApproval(
  db: DbSession,
  options: { approvalId: string; resolverRef?: string; now?: Date },
): Promise<BrowserApprovalRow | undefined> {
  return resolveApproval(db, {
    approvalId: options.approvalId,
    status: 'cancelled',
    resolver: 'telegram',
    ...(options.resolverRef !== undefined ? { resolverRef: options.resolverRef } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
}

export function expireApproval(
  db: DbSession,
  options: { approvalId: string; now?: Date },
): Promise<BrowserApprovalRow | undefined> {
  return resolveApproval(db, {
    approvalId: options.approvalId,
    status: 'expired',
    resolver: 'system',
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
}

export type ApprovalWaitOutcome =
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'interrupted'
  | 'cancel_requested'

export interface WaitForApprovalOptions {
  db: Db
  taskId: string
  approvalId: string
  expiresAt: Date
  /** Worker shutdown: the wait stops and the caller marks the task interrupted. */
  signal?: AbortSignal
  pollMs?: number
  now?: () => Date
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    const onAbort = () => done()
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function waitOutcomeFor(status: string): ApprovalWaitOutcome {
  if (status === 'approved') return 'approved'
  if (status === 'denied') return 'denied'
  if (status === 'cancelled') return 'cancelled'
  return 'expired'
}

/**
 * Hold the page while the user decides. Resolves on an approved/denied/cancelled/expired
 * approval, a Stop request, or shutdown; a timeout expires the approval through the same
 * conditional update, and losing that race re-reads the row (an approval that won executes).
 */
export async function waitForApproval(
  options: WaitForApprovalOptions,
): Promise<ApprovalWaitOutcome> {
  const { db, signal } = options
  const pollMs = options.pollMs ?? APPROVAL_POLL_MS
  const deadline = options.expiresAt.getTime()

  while (true) {
    if (signal?.aborted) return 'interrupted'

    const [approval] = await db
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, options.approvalId))
      .limit(1)
    if (!approval) return 'expired'
    if (approval.status !== 'pending') return waitOutcomeFor(approval.status)

    const [task] = await db
      .select({ status: browserTasks.status, cancelRequestedAt: browserTasks.cancelRequestedAt })
      .from(browserTasks)
      .where(eq(browserTasks.id, options.taskId))
      .limit(1)
    if (!task) return 'cancelled'
    if (task.cancelRequestedAt !== null) return 'cancel_requested'
    if (!(BROWSER_TASK_OPEN_STATUSES as readonly string[]).includes(task.status)) {
      return 'cancelled'
    }

    const now = options.now?.() ?? new Date()
    if (now.getTime() >= deadline) {
      await expireApproval(db, { approvalId: options.approvalId, now })
      const [again] = await db
        .select({ status: approvals.status })
        .from(approvals)
        .where(eq(approvals.id, options.approvalId))
        .limit(1)
      return again ? waitOutcomeFor(again.status) : 'expired'
    }

    await sleep(Math.max(1, Math.min(pollMs, deadline - now.getTime())), signal)
  }
}
