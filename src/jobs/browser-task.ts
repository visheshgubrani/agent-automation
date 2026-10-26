/**
 * The `browser-task` job (phase 05 increment 3): claim the single active slot, check the
 * daily cap, connect over CDP, prepare the form with the agent, hold the page for approval,
 * then execute the approved payload without the model.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { and, eq, isNull } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { z } from 'zod'
import {
  type BrowserApprovalRow,
  cancelApproval,
  createSubmitApproval,
  expireApproval,
  waitForApproval,
} from '../agent/approvals.js'
import { runBrowserAgent } from '../agent/browser-agent.js'
import { type ApprovalOutcome, BrowserToolbox, type HumanOutcome } from '../agent/browser-tools.js'
import { checkDailyCap } from '../agent/caps.js'
import { pauseForCommentAdvice } from '../agent/comment-advice.js'
import { composeRedditComment } from '../agent/comments.js'
import {
  BROWSER_TASK_HOLDING_STATUSES,
  type BrowserSubmitApprovalPayloadV1,
  type BrowserTaskResultV1,
  type BrowserTaskSpecV1,
  type BrowserTaskStatus,
  type BrowserTaskStatusReason,
  browserTaskSpecV1,
  isTaskPreparationGated,
} from '../agent/contracts.js'
import { executeApproval } from '../agent/executor.js'
import { createHandoff, waitForHandoff } from '../agent/handoffs.js'
import { composeApplicationNote } from '../agent/notes.js'
import { getApplicantProfile } from '../agent/profile.js'
import { noticeButtons, renderResultCard } from '../agent/render.js'
import { SCHEDULE_MISSED_AFTER_MS } from '../agent/schedules.js'
import {
  claimTaskSlot,
  enqueueResultNotice,
  finishBrowserTask,
  getBrowserTask,
} from '../agent/tasks.js'
import { RunNotStartedError, type RunTrigger, withRun } from '../audit/runs.js'
import type { BrowserDriver, BrowserSession } from '../browser/driver.js'
import { PlaywrightBrowserDriver } from '../browser/playwright-driver.js'
import { getSiteAction, type Site, type SiteAction } from '../browser/sites.js'
import type { AgentConfig } from '../config.js'
import { type Db, db as defaultDb } from '../db/index.js'
import {
  approvals,
  type BrowserTaskRow,
  browserTasks,
  telegramMessages,
} from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import { createBudgetedModel, isBudgetExhausted } from '../llm/budgeted-model.js'
import { createAgentProviderModel } from '../llm/openai.js'
import { type Logger, logger } from '../logger.js'
import { enqueueNotification } from '../notifications/outbox.js'
import { type BrowserTaskJobData, nudgeDispatch } from '../queue.js'

/** How often the job looks for a queued Stop while the agent or approval wait is active. */
export const CANCEL_POLL_MS = 1_000

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

export interface BrowserTaskJobContext {
  jobId: string
  data?: BrowserTaskJobData
  agent: AgentConfig
  boss: PgBoss
  db?: Db
  /** Test seam; defaults to the Playwright driver over `agent.browser.cdpUrl`. */
  driver?: BrowserDriver
  /** Test seam; defaults to the runtime-budgeted provider model for this run. */
  modelFactory?: (runId: string) => LanguageModelV4
  /** Raw note model test seam; note calls always use createBudgetedModel. */
  composeModel?: LanguageModelV4
  /** Worker shutdown flag. */
  signal?: AbortSignal
  now?: () => Date
  log?: Logger
}

export interface BrowserTaskJobResult {
  runOpened: boolean
  status?: BrowserTaskStatus
  statusReason?: BrowserTaskStatusReason
}

function triggerFor(source: BrowserTaskRow['source']): RunTrigger {
  if (source === 'retry') return 'retry'
  if (source === 'schedule') return 'schedule'
  return 'telegram'
}

function defaultModelFactory(
  db: Db,
  agent: AgentConfig,
  additionalRunIds: readonly string[] = [],
): (runId: string) => LanguageModelV4 {
  return (runId) =>
    createBudgetedModel(createAgentProviderModel(agent), {
      db,
      runId,
      additionalRunIds,
      purpose: 'agent_browser_step',
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      maxOutputTokens: agent.maxOutputTokens,
      taskMaxUsd: agent.taskMaxUsd,
    })
}

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

interface NotifyContext {
  db: Db
  boss: PgBoss
  log: Logger
  viewUrl: string
  runId?: string
  nudge: boolean
}

async function enqueueResultCard(context: NotifyContext, task: BrowserTaskRow): Promise<void> {
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

interface FinishOptions {
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
async function finishAndNotify(options: FinishOptions): Promise<BrowserTaskRow | undefined> {
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

interface TaskRunState {
  approvalOutcome?: ApprovalOutcome
  humanOutcome?: HumanOutcome
}

interface RequestApprovalOptions {
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
async function requestApproval(options: RequestApprovalOptions): Promise<ApprovalOutcome> {
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

async function loadApproval(db: Db, approvalId: string): Promise<BrowserApprovalRow> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1)
  if (!row) throw new Error('approval row for the task is missing')
  return row
}

interface RunTaskOptions {
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

async function runConnectedTask(
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

  let agentOutcome: Awaited<ReturnType<typeof runBrowserAgent>>
  try {
    agentOutcome = await runBrowserAgent({
      model: options.modelFactory(runId),
      config: agent,
      toolbox,
      site,
      action,
      spec,
      instruction: task.instruction,
      ...(options.signal !== undefined ? { shutdownSignal: options.signal } : {}),
      taskCancelSignal: taskCancel.signal,
    })
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

async function runTask(options: RunTaskOptions): Promise<BrowserTaskJobResult> {
  const { db, log, boss, agent, runId, taskId } = options
  const viewUrl = agent.browser.viewUrl
  const notify: NotifyContext = { db, boss, log, viewUrl, runId, nudge: !options.signal?.aborted }

  const claim = await claimTaskSlot(db, {
    taskId,
    runId,
    bossJobId: options.jobId,
    now: options.now(),
  })
  if (claim === 'not_queued') return { runOpened: false }
  if (claim === 'busy') {
    await finishAndNotify({
      context: { ...notify, nudge: false },
      taskId,
      from: ['queued'],
      status: 'failed',
      statusReason: 'interrupted',
      now: options.now(),
    })
    throw new BrowserTaskOutcomeError('failed', 'interrupted')
  }

  const task = await getBrowserTask(db, taskId)
  if (!task) throw new Error(`browser task ${taskId} vanished after claiming its slot`)

  if (
    task.source === 'schedule' &&
    task.scheduledFor &&
    options.now().getTime() - task.scheduledFor.getTime() > SCHEDULE_MISSED_AFTER_MS
  ) {
    await finishAndNotify({
      context: notify,
      taskId,
      from: [...BROWSER_TASK_HOLDING_STATUSES],
      status: 'failed',
      statusReason: 'schedule_missed',
      now: options.now(),
    })
    throw new BrowserTaskOutcomeError('failed', 'schedule_missed')
  }

  const found = getSiteAction(task.site, task.action)
  const spec = browserTaskSpecV1.safeParse(task.spec)
  if (
    !found ||
    !spec.success ||
    !found.action.targetUrlPattern.test(task.targetUrl) ||
    spec.data.targetUrl !== task.targetUrl ||
    (spec.data.composeNote && !found.action.application) ||
    (spec.data.composeComment && task.action !== 'reddit_comment')
  ) {
    await finishAndNotify({
      context: notify,
      taskId,
      from: [...BROWSER_TASK_HOLDING_STATUSES],
      status: 'failed',
      statusReason: 'precondition_failed',
      now: options.now(),
    })
    throw new BrowserTaskOutcomeError('failed', 'precondition_failed')
  }
  const { site, action } = found

  const cap = await checkDailyCap(db, {
    site: site.key,
    action: action.key,
    cap: action.dailyCap,
    now: options.now(),
  })
  if (!cap.allowed) {
    log.info({ taskId, site: site.key, action: action.key, used: cap.used }, 'daily cap reached')
    await finishAndNotify({
      context: notify,
      taskId,
      from: [...BROWSER_TASK_HOLDING_STATUSES],
      status: 'failed',
      statusReason: 'daily_cap',
      now: options.now(),
    })
    throw new BrowserTaskOutcomeError('failed', 'daily_cap')
  }

  if (options.signal?.aborted) {
    await finishAndNotify({
      context: { ...notify, nudge: false },
      taskId,
      from: [...BROWSER_TASK_HOLDING_STATUSES],
      status: 'failed',
      statusReason: 'interrupted',
      now: options.now(),
    })
    throw new BrowserTaskOutcomeError('failed', 'interrupted')
  }

  let session: BrowserSession
  try {
    session = await options.driver.openSession()
  } catch (error) {
    log.error({ taskId, err: errorMessage(error) }, 'could not connect to the browser')
    await finishAndNotify({
      context: notify,
      taskId,
      from: [...BROWSER_TASK_HOLDING_STATUSES],
      status: 'failed',
      statusReason: 'precondition_failed',
      now: options.now(),
      result: { version: 1, summary: 'Could not reach the browser. Is the browser container up?' },
    })
    throw error
  }

  try {
    const targetId = await session.page.targetId().catch(() => undefined)
    if (targetId !== undefined) {
      await db
        .update(browserTasks)
        .set({ cdpTargetId: targetId, updatedAt: options.now() })
        .where(eq(browserTasks.id, task.id))
    }
    const current = (await getBrowserTask(db, task.id)) ?? task
    return await runConnectedTask(options, session, site, action, spec.data, current)
  } finally {
    await session.disconnect().catch((error: unknown) => {
      log.warn({ taskId, err: errorMessage(error) }, 'browser session disconnect failed')
    })
  }
}

/**
 * pg-boss handler for one browser task. Jobs whose task is no longer queued do nothing (the
 * DB is the idempotency anchor); side effects are never retried by the queue.
 */
export async function handleBrowserTaskJob(
  context: BrowserTaskJobContext,
): Promise<BrowserTaskJobResult> {
  const db = context.db ?? defaultDb
  const log = context.log ?? logger
  const taskId = context.data?.taskId
  if (!taskId) throw new Error('browser-task job is missing taskId')

  // Start enqueues while holding this lock. Wait for its commit before checking the gate,
  // otherwise a fast queue consumer could see the old gated row and lose the only job.
  const initial = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, taskId))
      .for('update')
      .limit(1)
    return task
  })
  if (initial?.status !== 'queued' || isTaskPreparationGated(initial.statusReason)) {
    log.debug({ taskId, status: initial?.status }, 'browser task is not queued; skipping')
    return { runOpened: false }
  }

  const driver =
    context.driver ?? new PlaywrightBrowserDriver({ cdpUrl: context.agent.browser.cdpUrl })
  const [message] = initial.requestMessageId
    ? await db
        .select({ payload: telegramMessages.payload })
        .from(telegramMessages)
        .where(eq(telegramMessages.id, initial.requestMessageId))
        .limit(1)
    : []
  const intakeRunId = z.uuid().safeParse(message?.payload.browserIntakeRunId)
  const pendingSpec = browserTaskSpecV1.safeParse(initial.spec)
  const previousRunIds = pendingSpec.success
    ? (pendingSpec.data.composeComment?.priorRunIds ?? [])
    : []
  const modelFactory =
    context.modelFactory ??
    defaultModelFactory(db, context.agent, [
      ...previousRunIds,
      ...(intakeRunId.success ? [intakeRunId.data] : []),
    ])
  const now = context.now ?? (() => new Date())

  try {
    return await withRun(
      {
        db,
        log,
        kind: 'browser_task',
        trigger: triggerFor(initial.source),
        bossJobId: context.jobId,
        input: { taskId },
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      },
      ({ run, log: runLog }) =>
        runTask({
          db,
          log: runLog,
          boss: context.boss,
          agent: context.agent,
          jobId: context.jobId,
          taskId,
          runId: run.id,
          driver,
          modelFactory,
          ...(context.composeModel ? { composeModel: context.composeModel } : {}),
          ...(intakeRunId.success ? { intakeRunId: intakeRunId.data } : {}),
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
          now,
        }),
    )
  } catch (error) {
    if (error instanceof BrowserTaskOutcomeError) {
      log.warn(
        { taskId, status: error.status, statusReason: error.statusReason ?? null },
        'browser task finished with a non-success outcome',
      )
      return { runOpened: true, status: error.status, statusReason: error.statusReason }
    }
    if (error instanceof RunNotStartedError) {
      // A job fetched during shutdown never started a run; keep the task visible instead of
      // leaving it queued with no remaining job.
      await finishAndNotify({
        context: {
          db,
          boss: context.boss,
          log,
          viewUrl: context.agent.browser.viewUrl,
          nudge: false,
        },
        taskId,
        from: ['queued'],
        status: 'failed',
        statusReason: 'interrupted',
        now: now(),
      }).catch(() => undefined)
      return { runOpened: false, status: 'failed', statusReason: 'interrupted' }
    }
    throw error
  }
}
