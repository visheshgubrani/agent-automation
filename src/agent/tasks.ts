/**
 * Browser task lifecycle (phase 05). Every transition is a conditional update so a stale
 * writer can never overwrite a terminal state; the one-active-task index is the hard guard.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { artifactPhotoRef } from '../browser/artifacts.js'
import type { Db, DbSession } from '../db/index.js'
import type { browserTaskSource } from '../db/schema/enums.js'
import {
  type BrowserTaskRow,
  browserHandoffs,
  browserTasks,
  notificationOutbox,
  toolCalls,
} from '../db/schema/index.js'
import { enqueueNotification, type NotificationRow } from '../notifications/outbox.js'
import { cancelApproval } from './approvals.js'
import {
  BROWSER_TASK_HOLDING_STATUSES,
  BROWSER_TASK_OPEN_STATUSES,
  type BrowserTaskResultV1,
  type BrowserTaskSpecV1,
  type BrowserTaskStatus,
  type BrowserTaskStatusReason,
  browserTaskResultV1,
  browserTaskSpecV1,
  isTaskPreparationGated,
} from './contracts.js'
import { cancelWaitingHandoffs } from './handoffs.js'
import { queuedButtons, renderQueuedCard, renderResultCard, resultButtons } from './render.js'

export type BrowserTaskSourceKind = (typeof browserTaskSource.enumValues)[number]

/** Postgres unique violation, found through Drizzle's wrapped error cause chain. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (
      candidate.code === '23505' &&
      (constraint === undefined || candidate.constraint === constraint)
    )
      return true
    current = candidate.cause
  }
  return false
}

export interface CreateBrowserTaskInput {
  source: BrowserTaskSourceKind
  site: string
  action: string
  targetUrl: string
  instruction: string
  spec: BrowserTaskSpecV1
  /** Unique intake anchor (D046), set for Telegram requests only. */
  requestMessageId?: string
  retryOfTaskId?: string
  confirmationRequired?: boolean
}

/**
 * Insert a queued task. With a request message id the insert is idempotent on the partial
 * unique index, so a retried intake job returns the original task instead of a duplicate.
 */
export async function createBrowserTask(
  db: Db,
  input: CreateBrowserTaskInput,
): Promise<{ task: BrowserTaskRow; created: boolean }> {
  const values = {
    source: input.source,
    site: input.site,
    action: input.action,
    targetUrl: input.targetUrl,
    instruction: input.instruction,
    spec: input.spec as unknown as Record<string, unknown>,
    ...(input.confirmationRequired ? { statusReason: 'confirmation_required' } : {}),
    ...(input.requestMessageId !== undefined ? { requestMessageId: input.requestMessageId } : {}),
    ...(input.retryOfTaskId !== undefined ? { retryOfTaskId: input.retryOfTaskId } : {}),
  }

  if (input.requestMessageId !== undefined) {
    const [inserted] = await db
      .insert(browserTasks)
      .values(values)
      .onConflictDoNothing({
        target: browserTasks.requestMessageId,
        where: sql`${browserTasks.requestMessageId} is not null`,
      })
      .returning()
    if (inserted) return { task: inserted, created: true }

    const [existing] = await db
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.requestMessageId, input.requestMessageId))
      .limit(1)
    if (!existing) {
      throw new Error(`browser task for message ${input.requestMessageId} vanished on conflict`)
    }
    return { task: existing, created: false }
  }

  const [inserted] = await db.insert(browserTasks).values(values).returning()
  if (!inserted) throw new Error('createBrowserTask did not return a row')
  return { task: inserted, created: true }
}

export async function getBrowserTask(db: Db, taskId: string): Promise<BrowserTaskRow | undefined> {
  const [task] = await db.select().from(browserTasks).where(eq(browserTasks.id, taskId)).limit(1)
  return task
}

export type ClaimTaskResult = 'claimed' | 'not_queued' | 'busy'

/**
 * Take the single active slot: lock the task, confirm it is still queued, confirm no other
 * task holds the browser, then move it to `running`. The partial unique index is the final
 * guard against two active tasks.
 */
export async function claimTaskSlot(
  db: Db,
  options: { taskId: string; runId: string; bossJobId?: string; now?: Date },
): Promise<ClaimTaskResult> {
  const now = options.now ?? new Date()
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, options.taskId))
      .for('update')
      .limit(1)
    if (task?.status !== 'queued' || isTaskPreparationGated(task.statusReason)) return 'not_queued'

    const [active] = await tx
      .select({ id: browserTasks.id })
      .from(browserTasks)
      .where(inArray(browserTasks.status, [...BROWSER_TASK_HOLDING_STATUSES]))
      .limit(1)
    if (active) return 'busy'

    const [claimed] = await tx
      .update(browserTasks)
      .set({
        status: 'running',
        runId: options.runId,
        ...(options.bossJobId !== undefined ? { bossJobId: options.bossJobId } : {}),
        startedAt: now,
        updatedAt: now,
      })
      .where(and(eq(browserTasks.id, options.taskId), eq(browserTasks.status, 'queued')))
      .returning({ id: browserTasks.id })
    return claimed ? 'claimed' : 'not_queued'
  })
}

/** `awaiting_approval → executing`, immediately before the single click. */
export async function setTaskExecuting(
  db: DbSession,
  options: { taskId: string; now?: Date },
): Promise<boolean> {
  const now = options.now ?? new Date()
  const rows = await db
    .update(browserTasks)
    .set({ status: 'executing', updatedAt: now })
    .where(and(eq(browserTasks.id, options.taskId), eq(browserTasks.status, 'awaiting_approval')))
    .returning({ id: browserTasks.id })
  return rows.length > 0
}

/** Stamp the moment the click was issued; the submitted CHECK depends on this being honest. */
export async function markTaskSubmitted(
  db: DbSession,
  options: { taskId: string; now?: Date },
): Promise<void> {
  const now = options.now ?? new Date()
  await db
    .update(browserTasks)
    .set({ submittedAt: now, updatedAt: now })
    .where(and(eq(browserTasks.id, options.taskId), eq(browserTasks.status, 'executing')))
}

export interface FinishBrowserTaskInput {
  taskId: string
  /** Statuses the conditional update accepts; a mismatch leaves the row untouched. */
  from: readonly BrowserTaskStatus[]
  status: 'succeeded' | 'unverified' | 'outcome_unknown' | 'failed' | 'cancelled'
  statusReason?: BrowserTaskStatusReason
  result?: BrowserTaskResultV1
  submittedAt?: Date
  now?: Date
}

/** Move a task to a terminal status. Returns undefined when the row was not in `from`. */
export async function finishBrowserTask(
  db: Db,
  input: FinishBrowserTaskInput,
): Promise<BrowserTaskRow | undefined> {
  const now = input.now ?? new Date()
  const [row] = await db
    .update(browserTasks)
    .set({
      status: input.status,
      statusReason: input.statusReason ?? null,
      finishedAt: now,
      updatedAt: now,
      ...(input.result !== undefined
        ? { result: input.result as unknown as Record<string, unknown> }
        : {}),
      // Keep the earliest click timestamp if one was already stamped.
      ...(input.submittedAt !== undefined
        ? { submittedAt: sql`coalesce(${browserTasks.submittedAt}, ${input.submittedAt})` }
        : {}),
    })
    .where(and(eq(browserTasks.id, input.taskId), inArray(browserTasks.status, [...input.from])))
    .returning()
  return row
}

export type CancelTaskOutcome = 'cancelled' | 'requested' | 'finished' | 'not_found'

/**
 * Stop button. Queued, waiting-for-human, and awaiting-approval tasks end immediately; a running agent is asked
 * to stop through `cancel_requested_at` (the job aborts it). A submit that has started
 * (`executing`) is never aborted.
 */
export async function requestTaskCancel(
  db: Db,
  options: { taskId: string; resolverRef?: string; now?: Date; handoffId?: string },
): Promise<CancelTaskOutcome> {
  const now = options.now ?? new Date()
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, options.taskId))
      .for('update')
      .limit(1)
    if (!task) return 'not_found'
    if (!(BROWSER_TASK_OPEN_STATUSES as readonly string[]).includes(task.status)) return 'finished'
    if (options.handoffId !== undefined) {
      const [handoff] = await tx
        .select()
        .from(browserHandoffs)
        .where(and(eq(browserHandoffs.id, options.handoffId), eq(browserHandoffs.taskId, task.id)))
        .limit(1)
      if (
        task.status !== 'waiting_for_human' ||
        handoff?.status !== 'waiting' ||
        handoff.expiresAt <= now
      )
        return 'finished'
    }

    if (task.status === 'queued' || task.status === 'waiting_for_human') {
      await cancelWaitingHandoffs(tx, {
        taskId: task.id,
        now,
        ...(options.resolverRef !== undefined ? { resolverRef: options.resolverRef } : {}),
      })
      const [row] = await tx
        .update(browserTasks)
        .set({
          status: 'cancelled',
          statusReason: 'cancelled_by_user',
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(eq(browserTasks.id, options.taskId), eq(browserTasks.status, task.status)))
        .returning({ id: browserTasks.id })
      return row ? 'cancelled' : 'finished'
    }

    if (task.status === 'awaiting_approval') {
      if (task.approvalId) {
        await cancelApproval(tx, {
          approvalId: task.approvalId,
          now,
          ...(options.resolverRef !== undefined ? { resolverRef: options.resolverRef } : {}),
        })
      }
      const [row] = await tx
        .update(browserTasks)
        .set({
          status: 'cancelled',
          statusReason: 'cancelled_by_user',
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(browserTasks.id, options.taskId), eq(browserTasks.status, 'awaiting_approval')),
        )
        .returning({ id: browserTasks.id })
      return row ? 'cancelled' : 'finished'
    }

    await tx
      .update(browserTasks)
      .set({ cancelRequestedAt: now, updatedAt: now })
      .where(eq(browserTasks.id, options.taskId))
    return 'requested'
  })
}

export type RetryTaskOutcome = 'created' | 'already_retried' | 'not_retryable' | 'not_found'

/**
 * Retry starts a new task (and later a new approval) linked by `retry_of_task_id`; the old
 * task and its approval are never reset. Only a finished task can be retried.
 */
export async function createRetryTask(
  db: Db,
  options: { taskId: string },
): Promise<{ outcome: RetryTaskOutcome; task?: BrowserTaskRow }> {
  return db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, options.taskId))
      .for('update')
      .limit(1)
    if (!original) return { outcome: 'not_found' }
    if ((BROWSER_TASK_OPEN_STATUSES as readonly string[]).includes(original.status)) {
      return { outcome: 'not_retryable' }
    }

    const [existing] = await tx
      .select({ id: browserTasks.id })
      .from(browserTasks)
      .where(eq(browserTasks.retryOfTaskId, original.id))
      .limit(1)
    if (existing) return { outcome: 'already_retried' }

    const parsedSpec = browserTaskSpecV1.safeParse(original.spec)
    let retrySpec = original.spec
    if (parsedSpec.success && parsedSpec.data.composeComment) {
      const request = { ...parsedSpec.data.composeComment, priorRunIds: [] }
      if (!request.answer) delete request.question
      retrySpec = { ...parsedSpec.data, composeComment: request }
    }
    const [created] = await tx
      .insert(browserTasks)
      .values({
        source: 'retry',
        site: original.site,
        action: original.action,
        targetUrl: original.targetUrl,
        instruction: original.instruction,
        spec: retrySpec,
        retryOfTaskId: original.id,
      })
      .returning()
    if (!created) throw new Error('createRetryTask did not return a row')
    return { outcome: 'created', task: created }
  })
}

/** Queue the "Task queued" card with its Stop button; the dedupe key makes it idempotent. */
export async function enqueueQueuedNotice(
  db: DbSession,
  options: { task: BrowserTaskRow; runId?: string },
): Promise<NotificationRow> {
  const { notification } = await enqueueNotification(db, {
    kind: 'system',
    dedupeKey: `browser:task:${options.task.id}:queued`,
    body: renderQueuedCard(options.task),
    payload: { inlineButtons: queuedButtons(options.task.id) },
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  })
  return notification
}

/**
 * Queue the result card for a finished task (success, failure, cancellation, or an unknown
 * outcome), with its Retry/Open-browser buttons and the evidence screenshot when present.
 */
export async function enqueueResultNotice(
  db: DbSession,
  options: { task: BrowserTaskRow; runId?: string; viewUrl?: string },
): Promise<NotificationRow> {
  const parsed =
    options.task.result !== null ? browserTaskResultV1.safeParse(options.task.result) : undefined
  const result: BrowserTaskResultV1 | undefined = parsed?.success ? parsed.data : undefined
  const buttons = resultButtons(
    options.task,
    options.viewUrl !== undefined ? { viewUrl: options.viewUrl } : {},
  )
  const photo =
    result?.screenshotArtifactId !== undefined
      ? await artifactPhotoRef(db, result.screenshotArtifactId)
      : undefined

  const { notification } = await enqueueNotification(db, {
    kind: 'system',
    dedupeKey: `browser:task:${options.task.id}:result`,
    body: renderResultCard(options.task, result),
    payload: {
      ...(photo !== undefined ? { photo } : {}),
      ...(buttons.length > 0 ? { inlineButtons: buttons } : {}),
    },
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  })
  return notification
}

/** The one `send` tool call claimed for an approval, if any (startup recovery reads it). */
export async function findSendToolCallForApproval(
  db: Db,
  approvalId: string,
): Promise<typeof toolCalls.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(toolCalls)
    .where(eq(toolCalls.approvalId, approvalId))
    .orderBy(desc(toolCalls.startedAt))
    .limit(1)
  return row
}

/** Latest outbox row for a Telegram message, used to validate `bt:` callbacks. */
export async function findOutboxRowForMessage(
  db: Db,
  telegramMessageId: number,
): Promise<typeof notificationOutbox.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.telegramMessageId, telegramMessageId))
    .orderBy(desc(notificationOutbox.sentAt))
    .limit(1)
  return row
}
