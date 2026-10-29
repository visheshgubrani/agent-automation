/**
 * Shared browser-task outcome handling (phase 05 increment 10, P05-T01): notification and
 * finish helpers, approval request/load, and the connected-run context type. Behavior-preserving
 * extraction from `browser-task.ts`; the job entry point stays in the job module.
 */

import type { LanguageModelV4 } from '@ai-sdk/provider'
import { eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import {
  type BrowserApprovalRow,
  cancelApproval,
  createSubmitApproval,
  expireApproval,
  waitForApproval,
} from '../agent/approvals.js'
import type { ApprovalOutcome, HumanOutcome } from '../agent/browser-tools.js'
import type {
  BrowserSubmitApprovalPayloadV1,
  BrowserTaskResultV1,
  BrowserTaskStatus,
  BrowserTaskStatusReason,
} from '../agent/contracts.js'
import { noticeButtons, renderResultCard } from '../agent/render.js'
import { enqueueResultNotice, finishBrowserTask, getBrowserTask } from '../agent/tasks.js'
import type { BrowserDriver } from '../browser/driver.js'
import type { AgentConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { approvals, type BrowserTaskRow } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import type { Logger } from '../logger.js'
import { enqueueNotification } from '../notifications/outbox.js'
import { nudgeDispatch } from '../queue.js'

/** Thrown after the task's terminal state is written, so the run records the business outcome. */
export class BrowserTaskOutcomeError extends Error {
  readonly status: BrowserTaskStatus
  readonly statusReason?: BrowserTaskStatusReason

  constructor(status: BrowserTaskStatus, statusReason?: BrowserTaskStatusReason) {
    super(`browser task ended: ${status}${statusReason ? ` (${statusReason})` : ''}`)
    this.name = 'BrowserTaskOutcomeError'
    this.status = status
    this.statusReason = statusReason
  }
}

export interface NotifyContext {
  db: Db
  boss: PgBoss
  log: Logger
  viewUrl: string
  runId?: string
  nudge: boolean
}

export async function enqueueResultCard(
  context: NotifyContext,
  task: BrowserTaskRow,
): Promise<void> {
  await enqueueResultNotice(context.db, {
    task,
    viewUrl: context.viewUrl,
    ...(context.runId !== undefined ? { runId: context.runId } : {}),
  })
  if (context.nudge) {
    await nudgeDispatch(context.boss).catch((error: unknown) => {
      context.log.warn({ err: errorMessage(error) }, 'could not nudge notification dispatch')
    })
  }
}

export interface FinishOptions {
  context: NotifyContext
  taskId: string
  from: readonly BrowserTaskStatus[]
  status: 'failed' | 'cancelled' | 'unverified' | 'outcome_unknown'
  statusReason?: BrowserTaskStatusReason
  result?: BrowserTaskResultV1
  submittedAt?: Date
  now: Date
}

/**
 * Write the terminal task state and send its result card. Returns undefined when a concurrent
 * Stop had already moved the row; nothing is overwritten in that case.
 */
export async function finishAndNotify(options: FinishOptions): Promise<BrowserTaskRow | undefined> {
  const finished = await finishBrowserTask(options.context.db, {
    taskId: options.taskId,
    from: options.from,
    status: options.status,
    ...(options.statusReason !== undefined ? { statusReason: options.statusReason } : {}),
    ...(options.result !== undefined ? { result: options.result } : {}),
    ...(options.submittedAt !== undefined ? { submittedAt: options.submittedAt } : {}),
    now: options.now,
  })
  if (finished) await enqueueResultCard(options.context, finished)
  return finished
}

export interface TaskRunState {
  approvalOutcome?: ApprovalOutcome
  humanOutcome?: HumanOutcome
}

export interface RequestApprovalOptions {
  db: Db
  boss: PgBoss
  log: Logger
  task: BrowserTaskRow
  runId: string
  payload: BrowserSubmitApprovalPayloadV1
  approvalTimeoutMinutes: number
  signal?: AbortSignal
  viewUrl: string
  now: () => Date
  state: TaskRunState
}

/**
 * Create the approval, nudge dispatch, and wait while holding the page. On shutdown the task
 * is failed and the approval expired immediately, before the wait returns.
 */
export async function requestApproval(options: RequestApprovalOptions): Promise<ApprovalOutcome> {
  const { db, task } = options
  const requestedAt = options.now()
  const expiresAt = new Date(
    requestedAt.getTime() + Math.max(1, options.approvalTimeoutMinutes) * 60_000,
  )

  const created = await createSubmitApproval(db, {
    task,
    runId: options.runId,
    payload: options.payload,
    expiresAt,
    now: requestedAt,
  })
  if (!created) return 'cancelled'

  await nudgeDispatch(options.boss).catch((error: unknown) => {
    options.log.warn({ err: errorMessage(error) }, 'could not nudge notification dispatch')
  })

  const outcome = await waitForApproval({
    db,
    taskId: task.id,
    approvalId: created.approval.id,
    expiresAt,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })

  if (outcome === 'interrupted') {
    await finishBrowserTask(db, {
      taskId: task.id,
      from: ['awaiting_approval'],
      status: 'failed',
      statusReason: 'interrupted',
      now: options.now(),
    })
    await expireApproval(db, { approvalId: created.approval.id, now: options.now() })
    const finished = await getBrowserTask(db, task.id)
    if (finished) {
      // No nudge during shutdown: the pending outbox row goes out after the next start.
      await enqueueNotification(db, {
        kind: 'system',
        dedupeKey: `browser:task:${task.id}:recovered`,
        body: renderResultCard(finished),
        payload: { inlineButtons: noticeButtons(task.id, { viewUrl: options.viewUrl }) },
        runId: options.runId,
      })
    }
    return 'interrupted'
  }

  if (outcome === 'cancel_requested') {
    // A Stop raced the wait: cancel both the approval and the task without a click.
    await cancelApproval(db, { approvalId: created.approval.id, now: options.now() })
    await finishAndNotify({
      context: {
        db,
        boss: options.boss,
        log: options.log,
        viewUrl: options.viewUrl,
        runId: options.runId,
        nudge: options.signal?.aborted !== true,
      },
      taskId: task.id,
      from: ['awaiting_approval'],
      status: 'cancelled',
      statusReason: 'cancelled_by_user',
      now: options.now(),
    })
    return 'cancelled'
  }

  return outcome
}

export async function loadApproval(db: Db, approvalId: string): Promise<BrowserApprovalRow> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1)
  if (!row) throw new Error('approval row for the task is missing')
  return row
}

export interface RunTaskOptions {
  db: Db
  log: Logger
  boss: PgBoss
  agent: AgentConfig
  jobId: string
  taskId: string
  runId: string
  driver: BrowserDriver
  modelFactory: (runId: string) => LanguageModelV4
  composeModel?: LanguageModelV4
  intakeRunId?: string
  signal?: AbortSignal
  now: () => Date
}
