/**
 * Telegram surface for browser tasks: deterministic `/comment`, background free-text intake,
 * and the `bt:` Approve/Cancel/Stop/Retry/Done/Start callbacks. Every callback is validated
 * against the stored outbox row, its delivery status, and its expiry before it acts.
 */

import { and, eq, gt } from 'drizzle-orm'
import { approveApproval, denyApproval } from '../agent/approvals.js'
import { completeHandoff } from '../agent/handoffs.js'
import { parseCommentCommand } from '../agent/intake.js'
import { renderIntakeUsage } from '../agent/render.js'
import {
  createRetryTask,
  enqueueQueuedNotice,
  enqueueResultNotice,
  findOutboxRowForMessage,
  getBrowserTask,
  requestTaskCancel,
} from '../agent/tasks.js'
import type { Db } from '../db/index.js'
import { browserHandoffs, browserTasks } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import type { Logger } from '../logger.js'
import { type BrowserTaskJobData, QUEUES } from '../queue.js'
import { handleBrowserOperationsCallback, isTaskListCard } from './browser-operations.js'
import type { TelegramResponder } from './mail.js'

const ANSWER_LIMIT = 200

export interface BrowserHandlerContext {
  db: Db
  chatDbId: string
  runId: string
  updateId: number
  responder: TelegramResponder
  log: Logger
  /** Worker's pg-boss send, injected; absent when the agent is disabled. */
  enqueue?: (queue: string, data: Record<string, unknown>) => Promise<void>
  /** Worker's dispatch nudge; absent in tests that do not need it. */
  nudge?: () => Promise<void>
  viewUrl?: string
}

export interface CommentCommandContext extends BrowserHandlerContext {
  /** The stored inbound `telegram_messages` row id. */
  inboundMessageId: string
}

function answerText(value: string): string {
  return value.length <= ANSWER_LIMIT ? value : `${value.slice(0, ANSWER_LIMIT - 1)}…`
}

/**
 * `/comment <thread url>` stores nothing itself: the update handler already saved the message,
 * and the `agent-intake` job parses it and creates the task. Invalid input is answered here
 * immediately; valid input is answered by the Queued card from intake.
 */
export async function handleCommentCommand(
  text: string,
  context: CommentCommandContext,
): Promise<void> {
  if (!parseCommentCommand(text)) {
    await context.responder.reply(renderIntakeUsage())
    return
  }
  if (!context.enqueue) {
    await context.responder.reply('Browser tasks are not enabled on this worker.')
    return
  }
  try {
    await context.enqueue(QUEUES.agentIntake.name, {
      telegramMessageId: context.inboundMessageId,
    })
  } catch (error) {
    await context.responder.reply('Could not queue the comment task; check the worker logs.')
    throw error
  }
}

/** Free text and replies are parsed by the background job; quoted messages are not forwarded. */
export async function handleFreeTextRequest(context: CommentCommandContext): Promise<void> {
  if (!context.enqueue) return
  try {
    await context.enqueue(QUEUES.agentIntake.name, { telegramMessageId: context.inboundMessageId })
  } catch (error) {
    await context.responder.reply('Could not queue the request; please send it again.')
    throw error
  }
}

export type BrowserCallbackKind = 'approve' | 'deny' | 'stop' | 'retry' | 'done' | 'start'

export interface BrowserCallback {
  kind: BrowserCallbackKind
  id: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CALLBACK_KINDS: Record<string, BrowserCallbackKind> = {
  ap: 'approve',
  no: 'deny',
  stop: 'stop',
  retry: 'retry',
  done: 'done',
  go: 'start',
}

export function parseBrowserCallback(data: string): BrowserCallback | undefined {
  const parts = data.split(':')
  if (parts[0] !== 'bt') return undefined
  const kind = CALLBACK_KINDS[parts[1] ?? '']
  const id = parts[2]
  if (parts.length !== 3 || !kind || !id || !UUID_PATTERN.test(id)) return undefined
  return { kind, id }
}

function taskNoticeKeys(taskId: string): { queued: string; result: string; recovered: string } {
  return {
    queued: `browser:task:${taskId}:queued`,
    result: `browser:task:${taskId}:result`,
    recovered: `browser:task:${taskId}:recovered`,
  }
}

async function nudge(context: BrowserHandlerContext): Promise<void> {
  if (!context.nudge) return
  try {
    await context.nudge()
  } catch (error) {
    context.log.warn({ err: errorMessage(error) }, 'could not nudge notification dispatch')
  }
}

async function enqueueBrowserTask(context: BrowserHandlerContext, taskId: string): Promise<void> {
  if (!context.enqueue) return
  await context.enqueue(QUEUES.browserTask.name, { taskId } satisfies BrowserTaskJobData)
}

/** A stale/tapped-twice callback is acknowledged and ignored; it never changes state. */
async function answerStale(context: BrowserHandlerContext, message: string): Promise<void> {
  await context.responder.answerCallback(answerText(message))
}

async function handleApprovalCallback(
  context: BrowserHandlerContext,
  callback: BrowserCallback,
  messageId: number,
): Promise<void> {
  const row = await findOutboxRowForMessage(context.db, messageId)
  if (row?.status !== 'sent') {
    await answerStale(context, 'This approval message is no longer active.')
    return
  }
  if (row.approvalId !== callback.id) {
    await answerStale(context, 'This approval does not match this message.')
    return
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    await answerStale(context, 'This approval has expired. Send the request again.')
    return
  }

  const resolverRef = `update:${context.updateId}`
  const resolved =
    callback.kind === 'approve'
      ? await approveApproval(context.db, { approvalId: callback.id, resolverRef })
      : await denyApproval(context.db, { approvalId: callback.id, resolverRef })

  if (!resolved) {
    await answerStale(context, 'This approval was already handled or has expired.')
    return
  }
  await context.responder.answerCallback(
    callback.kind === 'approve' ? 'Approved. Submitting now.' : 'Cancelled.',
  )
}

async function handleStopCallback(
  context: BrowserHandlerContext,
  taskId: string,
  messageId: number,
): Promise<void> {
  const row = await findOutboxRowForMessage(context.db, messageId)
  const [handoff] =
    row?.status === 'sent'
      ? await context.db
          .select({ id: browserHandoffs.id })
          .from(browserHandoffs)
          .where(
            and(
              eq(browserHandoffs.taskId, taskId),
              eq(browserHandoffs.notificationId, row.id),
              eq(browserHandoffs.status, 'waiting'),
              gt(browserHandoffs.expiresAt, new Date()),
            ),
          )
          .limit(1)
      : []
  const metadata = row?.payload?.browserTaskDraft as
    | { version?: unknown; taskId?: unknown }
    | undefined
  const draft =
    (row?.dedupeKey === `browser:task:${taskId}:draft` ||
      row?.dedupeKey === `browser:task:${taskId}:answer-draft`) &&
    metadata?.version === 1 &&
    metadata.taskId === taskId &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() > Date.now()
  const listCard = await isTaskListCard(context, messageId, taskId)
  if (
    !listCard &&
    (row?.status !== 'sent' ||
      (row.dedupeKey !== taskNoticeKeys(taskId).queued &&
        row.dedupeKey !== `browser:task:${taskId}:advice` &&
        !handoff &&
        !draft))
  ) {
    await answerStale(context, 'This task message is no longer active.')
    return
  }

  const outcome = await requestTaskCancel(context.db, {
    taskId,
    resolverRef: `update:${context.updateId}`,
    ...(handoff ? { handoffId: handoff.id } : {}),
  })
  if (outcome === 'not_found') {
    await context.responder.answerCallback('Task not found.')
    return
  }
  if (outcome === 'finished') {
    await context.responder.answerCallback('This task already finished.')
    return
  }
  if (outcome === 'requested') {
    await context.responder.answerCallback('Stopping the task.')
    return
  }

  // Queued/awaiting-approval tasks end immediately: send their cancellation result card.
  const task = await getBrowserTask(context.db, taskId)
  if (task) {
    await enqueueResultNotice(context.db, {
      task,
      runId: context.runId,
      ...(context.viewUrl !== undefined ? { viewUrl: context.viewUrl } : {}),
    })
    await nudge(context)
  }
  await context.responder.answerCallback('Cancelled.')
}

async function handleStartCallback(
  context: BrowserHandlerContext,
  taskId: string,
  messageId: number,
): Promise<void> {
  if (!context.enqueue) {
    await context.responder.answerCallback('Browser tasks are not enabled on this worker.')
    return
  }
  const row = await findOutboxRowForMessage(context.db, messageId)
  const metadata = row?.payload?.browserTaskDraft as
    | { version?: unknown; taskId?: unknown }
    | undefined
  if (
    row?.status !== 'sent' ||
    (row.dedupeKey !== `browser:task:${taskId}:draft` &&
      row.dedupeKey !== `browser:task:${taskId}:answer-draft`) ||
    metadata?.version !== 1 ||
    metadata.taskId !== taskId ||
    !row.expiresAt ||
    row.expiresAt.getTime() <= Date.now()
  ) {
    await answerStale(context, 'This task draft was already handled or has expired.')
    return
  }
  const expiresAt = row.expiresAt
  const started = await context.db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, taskId))
      .for('update')
      .limit(1)
    if (
      task?.status !== 'queued' ||
      task.statusReason !== 'confirmation_required' ||
      expiresAt.getTime() <= Date.now()
    )
      return false
    // A consumer must take this task lock before claiming it. Queue failure leaves the gate intact.
    await enqueueBrowserTask(context, task.id)
    await tx
      .update(browserTasks)
      .set({ statusReason: null, updatedAt: new Date() })
      .where(eq(browserTasks.id, task.id))
    await enqueueQueuedNotice(tx, { task: { ...task, statusReason: null }, runId: context.runId })
    return true
  })
  if (started) await nudge(context)
  await context.responder.answerCallback(
    started
      ? 'Task queued. You will approve the exact text before submitting.'
      : 'This task draft was already handled or has expired.',
  )
}

async function handleDoneCallback(
  context: BrowserHandlerContext,
  handoffId: string,
  messageId: number,
): Promise<void> {
  const row = await findOutboxRowForMessage(context.db, messageId)
  if (
    row?.status !== 'sent' ||
    !(await completeHandoff(context.db, {
      handoffId,
      notificationId: row.id,
      resolverRef: `update:${context.updateId}`,
    }))
  ) {
    await answerStale(context, 'This handoff was already handled or has expired.')
    return
  }
  await context.responder.answerCallback('Done. Checking the page again.')
}

async function handleRetryCallback(
  context: BrowserHandlerContext,
  taskId: string,
  messageId: number,
): Promise<void> {
  const row = await findOutboxRowForMessage(context.db, messageId)
  const keys = taskNoticeKeys(taskId)
  if (
    row?.status !== 'sent' ||
    (row.dedupeKey !== keys.result && row.dedupeKey !== keys.recovered)
  ) {
    await answerStale(context, 'This task message is no longer active.')
    return
  }

  if (!context.enqueue) {
    await context.responder.answerCallback('Browser tasks are not enabled on this worker.')
    return
  }

  const retry = await createRetryTask(context.db, { taskId })
  if (retry.outcome === 'not_found') {
    await context.responder.answerCallback('Task not found.')
    return
  }
  if (retry.outcome === 'not_retryable') {
    await context.responder.answerCallback('Stop the task before retrying it.')
    return
  }
  if (retry.outcome === 'already_retried' || !retry.task) {
    await context.responder.answerCallback('This task was already retried.')
    return
  }

  await enqueueBrowserTask(context, retry.task.id)
  await enqueueQueuedNotice(context.db, { task: retry.task, runId: context.runId })
  await nudge(context)
  await context.responder.answerCallback('Retry queued.')
}

/** Route one `bt:` callback. The handler answers exactly once, including for stale taps. */
export async function handleBrowserCallback(
  data: string,
  messageId: number | undefined,
  context: BrowserHandlerContext,
): Promise<void> {
  if (data.startsWith('bs:') || data.startsWith('bt:list:')) {
    await handleBrowserOperationsCallback(data, messageId, context)
    return
  }
  const callback = parseBrowserCallback(data)
  if (!callback) {
    await context.responder.answerCallback('Unknown browser action.')
    return
  }
  if (messageId === undefined) {
    await context.responder.answerCallback('This action needs a message context.')
    return
  }

  if (callback.kind === 'approve' || callback.kind === 'deny') {
    await handleApprovalCallback(context, callback, messageId)
    return
  }
  if (callback.kind === 'stop') {
    await handleStopCallback(context, callback.id, messageId)
    return
  }
  if (callback.kind === 'done') {
    await handleDoneCallback(context, callback.id, messageId)
    return
  }
  if (callback.kind === 'start') {
    await handleStartCallback(context, callback.id, messageId)
    return
  }
  await handleRetryCallback(context, callback.id, messageId)
}
