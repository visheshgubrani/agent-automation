/**
 * Connected browser-task preparation (phase 05 increment 10, P05-T02): the cancellation
 * watcher and the connected task runner. Behavior-preserving extraction from `browser-task.ts`;
 * queue entry, claiming, caps, connection ownership and disconnect stay in the job module.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { runBrowserPreparation } from '../agent/browser-controller.js'
import { BrowserToolbox } from '../agent/browser-tools.js'
import { pauseForCommentAdvice } from '../agent/comment-advice.js'
import { composeRedditComment } from '../agent/comments.js'
import {
  BROWSER_TASK_HOLDING_STATUSES,
  type BrowserTaskResultV1,
  type BrowserTaskSpecV1,
  type BrowserTaskStatusReason,
  browserTaskSpecV1,
} from '../agent/contracts.js'
import { executeApproval } from '../agent/executor.js'
import { createHandoff, waitForHandoff } from '../agent/handoffs.js'
import { composeApplicationNote } from '../agent/notes.js'
import { getApplicantProfile } from '../agent/profile.js'
import { getBrowserTask } from '../agent/tasks.js'
import type { BrowserSession } from '../browser/driver.js'
import type { Site, SiteAction } from '../browser/sites.js'
import type { Db } from '../db/index.js'
import { type BrowserTaskRow, browserTasks } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import { isBudgetExhausted } from '../llm/budgeted-model.js'
import type { Logger } from '../logger.js'
import { nudgeDispatch } from '../queue.js'
import type { BrowserTaskJobResult } from './browser-task.js'
import {
  BrowserTaskOutcomeError,
  enqueueResultCard,
  finishAndNotify,
  loadApproval,
  type NotifyContext,
  type RunTaskOptions,
  requestApproval,
  type TaskRunState,
} from './browser-task-state.js'

/** How often the job looks for a queued Stop while the agent or approval wait is active. */
const CANCEL_POLL_MS = 1_000

/** Poll for a Stop request while the agent or the approval wait holds the page. */
function startCancelWatcher(
  db: Db,
  taskId: string,
  controller: AbortController,
  log: Logger,
): () => void {
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        const [row] = await db
          .select({
            status: browserTasks.status,
            cancelRequestedAt: browserTasks.cancelRequestedAt,
          })
          .from(browserTasks)
          .where(eq(browserTasks.id, taskId))
          .limit(1)
        if (row && (row.cancelRequestedAt !== null || row.status === 'cancelled')) {
          controller.abort()
        }
      } catch (error) {
        log.warn({ taskId, err: errorMessage(error) }, 'could not check for a task stop request')
      } finally {
        busy = false
      }
    })()
  }, CANCEL_POLL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

export async function runConnectedTask(
  options: RunTaskOptions,
  session: BrowserSession,
  site: Site,
  action: SiteAction,
  spec: BrowserTaskSpecV1,
  task: BrowserTaskRow,
): Promise<BrowserTaskJobResult> {
  const { db, log, boss, agent, runId } = options
  const viewUrl = agent.browser.viewUrl
  const state: TaskRunState = {}
  const taskCancel = new AbortController()
  const stopWatcher = startCancelWatcher(db, task.id, taskCancel, log)
  const nudge = options.signal?.aborted !== true
  const notify: NotifyContext = { db, boss, log, viewUrl, runId, nudge }

  const fail = async (
    status: 'failed' | 'cancelled' | 'unverified' | 'outcome_unknown',
    statusReason?: BrowserTaskStatusReason,
    extras: { summary?: string; screenshotArtifactId?: string } = {},
  ): Promise<never> => {
    const result: BrowserTaskResultV1 | undefined =
      extras.summary !== undefined || extras.screenshotArtifactId !== undefined
        ? {
            version: 1,
            ...(extras.summary !== undefined ? { summary: extras.summary } : {}),
            ...(extras.screenshotArtifactId !== undefined
              ? { screenshotArtifactId: extras.screenshotArtifactId }
              : {}),
          }
        : undefined
    const submitted = status === 'unverified' || status === 'outcome_unknown'
    await finishAndNotify({
      context: notify,
      taskId: task.id,
      from: [...BROWSER_TASK_HOLDING_STATUSES],
      status,
      ...(statusReason !== undefined ? { statusReason } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(submitted ? { submittedAt: options.now() } : {}),
      now: options.now(),
    })
    throw new BrowserTaskOutcomeError(status, statusReason)
  }

  const toolbox = new BrowserToolbox({
    db,
    log,
    runId,
    taskId: task.id,
    site,
    action,
    spec,
    page: session.page,
    artifactDir: agent.browser.artifactDir,
    now: options.now,
    hooks: {
      composeComment: async (post) => {
        const request = spec.composeComment
        if (!request) throw new Error('The task has no pending comment request.')
        const composition = await composeRedditComment({
          db,
          runId,
          agent,
          request,
          post,
          ...(options.intakeRunId ? { additionalRunIds: [options.intakeRunId] } : {}),
          ...(options.composeModel ? { model: options.composeModel } : {}),
          signal: AbortSignal.any([taskCancel.signal, ...(options.signal ? [options.signal] : [])]),
        })
        if (composition.kind === 'needs_input') {
          await pauseForCommentAdvice(db, {
            taskId: task.id,
            runId,
            spec,
            question: composition.question,
            now: options.now(),
          })
          await nudgeDispatch(boss).catch(() => log.warn('could not nudge comment advice dispatch'))
          return undefined
        }
        const prepared = browserTaskSpecV1.parse({
          version: 1,
          targetUrl: spec.targetUrl,
          fields: [{ key: 'comment_text', value: composition.text, provenance: 'drafted' }],
        })
        const [saved] = await db
          .update(browserTasks)
          .set({ spec: prepared, updatedAt: options.now() })
          .where(
            and(
              eq(browserTasks.id, task.id),
              eq(browserTasks.status, 'running'),
              isNull(browserTasks.cancelRequestedAt),
            ),
          )
          .returning({ id: browserTasks.id })
        if (!saved) throw new Error('The task stopped before its comment was saved.')
        return prepared
      },
      composeNote: async (jobExcerpt) => {
        const profile = await getApplicantProfile(db)
        const value = await composeApplicationNote({
          db,
          runId,
          agent,
          profile,
          jobExcerpt,
          ...(options.intakeRunId ? { additionalRunIds: [options.intakeRunId] } : {}),
          ...(options.composeModel ? { model: options.composeModel } : {}),
          signal: AbortSignal.any([taskCancel.signal, ...(options.signal ? [options.signal] : [])]),
        })
        const prepared = browserTaskSpecV1.parse({
          version: 1,
          targetUrl: spec.targetUrl,
          fields: [{ key: 'application_note', value, provenance: 'drafted' }],
        })
        const [saved] = await db
          .update(browserTasks)
          .set({ spec: prepared, updatedAt: options.now() })
          .where(
            and(
              eq(browserTasks.id, task.id),
              eq(browserTasks.status, 'running'),
              isNull(browserTasks.cancelRequestedAt),
            ),
          )
          .returning({ id: browserTasks.id })
        if (!saved) throw new Error('The task stopped before its note was saved.')
        return prepared
      },
      requestHuman: async (input) => {
        const requestedAt = options.now()
        const created = await createHandoff(db, {
          ...input,
          taskId: task.id,
          runId,
          viewUrl,
          now: requestedAt,
          expiresAt: new Date(requestedAt.getTime() + agent.browser.handoffTimeoutMinutes * 60_000),
        })
        if (created.outcome !== 'created') {
          state.humanOutcome = created.outcome
          return created.outcome
        }
        await nudgeDispatch(boss).catch((error: unknown) => {
          log.warn({ err: errorMessage(error) }, 'could not nudge notification dispatch')
        })
        const outcome = await waitForHandoff({
          db,
          taskId: task.id,
          handoffId: created.handoff.id,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          now: options.now,
        })
        state.humanOutcome = outcome
        if (outcome !== 'resolved') {
          const finished = await getBrowserTask(db, task.id)
          if (finished && finished.finishedAt !== null) {
            await enqueueResultCard({ ...notify, nudge: !options.signal?.aborted }, finished)
          }
        }
        return outcome
      },
      requestSubmitApproval: async (payload) => {
        const outcome = await requestApproval({
          db,
          boss,
          log,
          task,
          runId,
          payload,
          approvalTimeoutMinutes: agent.browser.approvalTimeoutMinutes,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          viewUrl,
          now: options.now,
          state,
        })
        // The tool result and the job's outcome must agree, including interruption.
        state.approvalOutcome = outcome
        return outcome
      },
    },
  })

  let agentOutcome: Awaited<ReturnType<typeof runBrowserPreparation>>
  try {
    const prepare = {
      model: options.modelFactory(runId),
      config: agent,
      toolbox,
      site,
      action,
      spec,
      instruction: task.instruction,
      ...(options.signal !== undefined ? { shutdownSignal: options.signal } : {}),
      taskCancelSignal: taskCancel.signal,
      log: log.child({ taskId: task.id }),
    }
    agentOutcome = await runBrowserPreparation(prepare)
  } finally {
    stopWatcher()
  }

  if (toolbox.adviceRequired)
    return { runOpened: true, status: 'queued', statusReason: 'advice_required' }
  if (toolbox.commentError !== undefined) {
    if (options.signal?.aborted) return fail('failed', 'interrupted')
    if (taskCancel.signal.aborted) return fail('cancelled', 'cancelled_by_user')
    return fail(
      'failed',
      isBudgetExhausted(toolbox.commentError) ? 'budget_exhausted' : 'precondition_failed',
      {
        summary:
          'Could not draft a grounded comment with the available context. Nothing was submitted.',
      },
    )
  }
  if (toolbox.alreadyApplied) return fail('failed', 'already_applied')
  if (toolbox.noteError !== undefined) {
    if (options.signal?.aborted) return fail('failed', 'interrupted')
    if (taskCancel.signal.aborted) return fail('cancelled', 'cancelled_by_user')
    return fail(
      'failed',
      isBudgetExhausted(toolbox.noteError) ? 'budget_exhausted' : 'precondition_failed',
      {
        summary:
          'Could not draft an application note. Set a valid applicant profile with pnpm agent:profile set --file <path>, then retry.',
      },
    )
  }

  if (state.humanOutcome && state.humanOutcome !== 'resolved') {
    switch (state.humanOutcome) {
      case 'cancelled':
        return fail('cancelled', 'cancelled_by_user')
      case 'timed_out':
        return fail('failed', 'handoff_timeout')
      case 'limit_reached':
        return fail('failed', 'handoff_limit')
      case 'interrupted':
        return fail('failed', 'interrupted')
    }
  }

  switch (agentOutcome.end) {
    case 'budget_exhausted':
      return fail('failed', 'budget_exhausted', {
        summary: 'The agent model budget is used up for today.',
      })
    case 'interrupted':
      await finishAndNotify({
        context: { ...notify, nudge: false },
        taskId: task.id,
        from: [...BROWSER_TASK_HOLDING_STATUSES],
        status: 'failed',
        statusReason: 'interrupted',
        now: options.now(),
      })
      throw new BrowserTaskOutcomeError('failed', 'interrupted')
    case 'cancelled':
      return fail('cancelled', 'cancelled_by_user')
    case 'step_limit':
      return fail('failed', 'step_limit')
    case 'reported':
      return fail('failed', 'precondition_failed', {
        ...(agentOutcome.summary !== undefined ? { summary: agentOutcome.summary } : {}),
      })
    case 'error':
      log.error(
        { taskId: task.id, err: errorMessage(agentOutcome.error, 500) },
        'browser agent failed before approval',
      )
      return fail('failed', 'precondition_failed', {
        summary: 'The agent could not prepare the submission.',
      })
    case 'completed':
      return fail('failed', 'precondition_failed')
    case 'approval_requested':
      break
  }

  const approvalOutcome = state.approvalOutcome
  if (approvalOutcome === undefined) {
    return fail('failed', 'precondition_failed')
  }
  if (approvalOutcome === 'interrupted') {
    throw new BrowserTaskOutcomeError('failed', 'interrupted')
  }
  if (approvalOutcome === 'denied') {
    return fail('cancelled', 'cancelled_by_user')
  }
  if (approvalOutcome === 'expired') {
    return fail('failed', 'approval_expired')
  }
  if (approvalOutcome === 'cancelled') {
    return fail('cancelled', 'cancelled_by_user')
  }

  const refreshed = await getBrowserTask(db, task.id)
  if (!refreshed) throw new Error(`browser task ${task.id} vanished before execution`)
  if (!refreshed.approvalId) {
    log.warn({ taskId: task.id }, 'approved task has no approval row')
    throw new BrowserTaskOutcomeError('failed', 'precondition_failed')
  }

  const execution = await executeApproval({
    db,
    log,
    task: refreshed,
    approval: await loadApproval(db, refreshed.approvalId),
    site,
    action,
    page: session.page,
    artifactDir: agent.browser.artifactDir,
    now: options.now,
  })

  if (execution.status === 'conflict') {
    return { runOpened: true, status: refreshed.status }
  }

  const finished = await getBrowserTask(db, task.id)
  if (finished) await enqueueResultCard(notify, finished)

  if (execution.status === 'outcome_unknown') {
    throw new BrowserTaskOutcomeError('outcome_unknown')
  }
  if (execution.status === 'failed') {
    throw new BrowserTaskOutcomeError('failed', 'precondition_failed')
  }
  return { runOpened: true, status: execution.status }
}
