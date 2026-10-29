/**
 * The `browser-task` job (phase 05 increment 3): claim the single active slot, check the
 * daily cap, connect over CDP, prepare the form with the agent, hold the page for approval,
 * then execute the approved payload without the model.
 */
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { z } from 'zod'
import { checkDailyCap } from '../agent/caps.js'
import {
  BROWSER_TASK_HOLDING_STATUSES,
  type BrowserTaskStatus,
  type BrowserTaskStatusReason,
  browserTaskSpecV1,
  isTaskPreparationGated,
} from '../agent/contracts.js'
import { SCHEDULE_MISSED_AFTER_MS } from '../agent/schedules.js'
import { claimTaskSlot, getBrowserTask } from '../agent/tasks.js'
import { RunNotStartedError, type RunTrigger, withRun } from '../audit/runs.js'
import type { BrowserDriver, BrowserSession } from '../browser/driver.js'
import { PlaywrightBrowserDriver } from '../browser/playwright-driver.js'
import { getSiteAction } from '../browser/sites.js'
import type { AgentConfig } from '../config.js'
import { type Db, db as defaultDb } from '../db/index.js'
import { type BrowserTaskRow, browserTasks, telegramMessages } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import { createBudgetedModel } from '../llm/budgeted-model.js'
import { createAgentProviderModel } from '../llm/openai.js'
import { type Logger, logger } from '../logger.js'
import type { BrowserTaskJobData } from '../queue.js'
import { runConnectedTask } from './browser-task-session.js'
import {
  BrowserTaskOutcomeError,
  finishAndNotify,
  type NotifyContext,
  type RunTaskOptions,
} from './browser-task-state.js'

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
  const extraRunIds = [...previousRunIds, ...(intakeRunId.success ? [intakeRunId.data] : [])]
  const modelFactory = context.modelFactory ?? defaultModelFactory(db, context.agent, extraRunIds)
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
