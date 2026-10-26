/**
 * Browser-task startup recovery (phase 05). The worker advisory lock guarantees no peer is
 * running, so every open task belongs to the previous process. Each affected task gets one
 * notice with Retry (and Open browser when the submit outcome is unknown).
 */
import { and, eq, inArray } from 'drizzle-orm'
import { markToolCallUnknown } from '../audit/calls.js'
import type { Db } from '../db/index.js'
import { type BrowserTaskRow, browserHandoffs, browserTasks } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import type { Logger } from '../logger.js'
import { enqueueNotification } from '../notifications/outbox.js'
import { expireApproval } from './approvals.js'
import { BROWSER_TASK_HOLDING_STATUSES } from './contracts.js'
import { noticeButtons, renderRecoveryNotice } from './render.js'
import { findSendToolCallForApproval, finishBrowserTask } from './tasks.js'

export interface BrowserRecoveryOptions {
  db: Db
  log: Logger
  /** HTTPS browser view URL used by the [Open browser] button. */
  viewUrl: string
  now?: Date
}

export interface BrowserRecoveryCounts {
  interrupted: number
  outcomeUnknown: number
  unverified: number
  approvalsExpired: number
  handoffsInterrupted: number
  notices: number
}

async function expirePendingApproval(db: Db, task: BrowserTaskRow, now: Date): Promise<boolean> {
  if (!task.approvalId) return false
  const expired = await expireApproval(db, { approvalId: task.approvalId, now })
  return expired !== undefined
}

async function interruptWaitingHandoffs(db: Db, taskId: string, now: Date): Promise<number> {
  const rows = await db
    .update(browserHandoffs)
    .set({ status: 'interrupted', resolvedAt: now })
    .where(and(eq(browserHandoffs.taskId, taskId), eq(browserHandoffs.status, 'waiting')))
    .returning({ id: browserHandoffs.id })
  return rows.length
}

async function sendRecoveryNotice(db: Db, task: BrowserTaskRow, viewUrl: string): Promise<boolean> {
  const { inserted } = await enqueueNotification(db, {
    kind: 'system',
    dedupeKey: `browser:task:${task.id}:recovered`,
    body: renderRecoveryNotice(task),
    payload: {
      inlineButtons: noticeButtons(task.id, {
        viewUrl,
        openBrowser: task.status === 'outcome_unknown',
      }),
    },
    ...(task.runId !== null ? { runId: task.runId } : {}),
  })
  return inserted
}

/**
 * Fail or reconcile every task left open by a restart. For `executing` tasks an in-flight
 * send becomes `unknown`, a finished send passes its outcome to the task, and a task with no
 * send tool call fails as interrupted (its approval stays consumed).
 */
export async function recoverBrowserTasks(
  options: BrowserRecoveryOptions,
): Promise<BrowserRecoveryCounts> {
  const { db, log, viewUrl } = options
  const now = options.now ?? new Date()
  const counts: BrowserRecoveryCounts = {
    interrupted: 0,
    outcomeUnknown: 0,
    unverified: 0,
    approvalsExpired: 0,
    handoffsInterrupted: 0,
    notices: 0,
  }

  const open = await db
    .select()
    .from(browserTasks)
    .where(inArray(browserTasks.status, [...BROWSER_TASK_HOLDING_STATUSES]))

  for (const task of open) {
    try {
      if (task.status === 'executing') {
        const call = task.approvalId
          ? await findSendToolCallForApproval(db, task.approvalId)
          : undefined

        if (call?.status === 'running') {
          await markToolCallUnknown(db, call.id, {
            error: new Error('worker restarted while the submit was in flight'),
          })
          await finishBrowserTask(db, {
            taskId: task.id,
            from: ['executing'],
            status: 'outcome_unknown',
            submittedAt: now,
            now,
          })
          counts.outcomeUnknown += 1
        } else if (call?.status === 'succeeded') {
          await finishBrowserTask(db, {
            taskId: task.id,
            from: ['executing'],
            status: 'unverified',
            submittedAt: now,
            now,
          })
          counts.unverified += 1
        } else if (call?.status === 'unknown') {
          await finishBrowserTask(db, {
            taskId: task.id,
            from: ['executing'],
            status: 'outcome_unknown',
            submittedAt: now,
            now,
          })
          counts.outcomeUnknown += 1
        } else {
          await finishBrowserTask(db, {
            taskId: task.id,
            from: ['executing'],
            status: 'failed',
            statusReason: 'interrupted',
            now,
          })
          counts.interrupted += 1
        }
      } else {
        await finishBrowserTask(db, {
          taskId: task.id,
          from: ['running', 'waiting_for_human', 'awaiting_approval'],
          status: 'failed',
          statusReason: 'interrupted',
          now,
        })
        if (await expirePendingApproval(db, task, now)) counts.approvalsExpired += 1
        counts.handoffsInterrupted += await interruptWaitingHandoffs(db, task.id, now)
        counts.interrupted += 1
      }

      const [finished] = await db
        .select()
        .from(browserTasks)
        .where(eq(browserTasks.id, task.id))
        .limit(1)
      if (finished && (await sendRecoveryNotice(db, finished, viewUrl))) counts.notices += 1
      log.warn(
        { taskId: task.id, previousStatus: task.status },
        'browser task recovered after restart',
      )
    } catch (error) {
      log.error(
        { taskId: task.id, err: errorMessage(error) },
        'failed to recover an interrupted browser task',
      )
    }
  }

  return counts
}
