/** Current-message intake. The decision is pinned before any page is read (D046/D050). */
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { consumeCommentAdvice } from '../agent/comment-advice.js'
import { browserTaskSpecV1, isTaskPreparationGated } from '../agent/contracts.js'
import {
  buildCommentSpec,
  clarification,
  type IntakePlan,
  intakePlanV1,
  isStaleRequest,
  parseCommentCommand,
  validateIntakeOutput,
} from '../agent/intake.js'
import { parseIntakeWithModel } from '../agent/intake-model.js'
import { INTAKE_MESSAGE_MAX_CHARS } from '../agent/intake-prompt.js'
import {
  draftTaskButtons,
  renderIntakeUsage,
  renderScheduleDraft,
  renderTaskDraft,
} from '../agent/render.js'
import { nextScheduleTimes, SCHEDULE_DRAFT_TTL_MS } from '../agent/schedules.js'
import { createBrowserTask, enqueueQueuedNotice } from '../agent/tasks.js'
import { withRun } from '../audit/runs.js'
import type { AgentConfig } from '../config.js'
import { type Db, db as defaultDb } from '../db/index.js'
import { telegramMessages } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import { isBudgetExhausted } from '../llm/budgeted-model.js'
import { type Logger, logger } from '../logger.js'
import { enqueueNotification } from '../notifications/outbox.js'
import {
  type AgentIntakeJobData,
  type BrowserTaskJobData,
  nudgeDispatch,
  QUEUES,
} from '../queue.js'

export const TASK_DRAFT_TTL_MS = 30 * 60_000

export interface AgentIntakeJobContext {
  jobId: string
  data?: AgentIntakeJobData
  boss: PgBoss
  db?: Db
  log?: Logger
  agent?: AgentConfig
  /** Raw provider model for tests; production always uses the budgeted provider. */
  model?: LanguageModelV4
  signal?: AbortSignal
  now?: () => Date
}

export interface AgentIntakeJobResult {
  runOpened: boolean
  outcome?: 'created' | 'existing' | 'invalid' | 'unclear' | 'schedule' | 'draft'
  taskId?: string
}

/** Save a decision once under the inbound row lock, including non-actionable decisions. */
async function decide(db: Db, context: AgentIntakeJobContext, messageId: string, runId: string) {
  return db.transaction(async (tx) => {
    const [message] = await tx
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.id, messageId))
      .for('update')
      .limit(1)
    if (message?.direction !== 'inbound')
      throw new Error('the telegram message for agent intake is missing')
    const cached = intakePlanV1.safeParse(message.payload.browserIntake)
    if (cached.success) return { message, plan: cached.data }
    let plan: IntakePlan
    if (/^\/comment(?:@\w+)?(?:\s|$)/i.test(message.text)) {
      const command = parseCommentCommand(message.text)
      plan = command
        ? {
            version: 1,
            kind: 'one_off',
            site: 'reddit',
            action: 'reddit_comment',
            spec: buildCommentSpec(command),
          }
        : { version: 1, kind: 'invalid' }
    } else if (message.text.trim().length === 0 || message.text.length > INTAKE_MESSAGE_MAX_CHARS) {
      plan = clarification(
        `Please send one request of at most ${INTAKE_MESSAGE_MAX_CHARS} characters with a target and the text to submit.`,
      )
    } else if (!context.agent) {
      plan = clarification('Browser tasks are not enabled on this worker.')
    } else {
      try {
        const output = await parseIntakeWithModel({
          db,
          runId,
          agent: context.agent,
          text: message.text,
          ...(context.model ? { model: context.model } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        })
        plan = validateIntakeOutput(output, message.text)
      } catch (error) {
        // SDK validation/provider errors can embed generated text. Never persist or log them.
        plan = clarification(
          isBudgetExhausted(error)
            ? 'The agent model budget is used up. Please resend the request after the budget resets.'
            : 'I could not safely parse that request. Please resend one action with its target and exact text.',
        )
      }
    }
    await tx
      .update(telegramMessages)
      .set({
        payload: {
          ...message.payload,
          browserIntake: plan,
          browserIntakeRunId: runId,
          ...(plan.kind === 'schedule'
            ? { browserScheduleDraft: { ...plan, instruction: message.text } }
            : {}),
        },
      })
      .where(eq(telegramMessages.id, message.id))
    return { message, plan }
  })
}

export async function handleAgentIntakeJob(
  context: AgentIntakeJobContext,
): Promise<AgentIntakeJobResult> {
  const db = context.db ?? defaultDb
  const log = context.log ?? logger
  const messageId = context.data?.telegramMessageId
  if (!messageId) throw new Error('agent-intake job is missing telegramMessageId')
  return withRun(
    {
      db,
      log,
      kind: 'agent_chat',
      trigger: 'telegram',
      bossJobId: context.jobId,
      input: { job: 'agent-intake', telegramMessageId: messageId },
      ...(context.signal ? { signal: context.signal } : {}),
    },
    async ({ run, log: runLog }) => {
      const now = context.now?.() ?? new Date()
      const nudge = async () => {
        await nudgeDispatch(context.boss).catch((error: unknown) => {
          runLog.warn({ err: errorMessage(error) }, 'could not nudge notification dispatch')
        })
      }
      const advice = await consumeCommentAdvice(db, {
        messageId,
        runId: run.id,
        boss: context.boss,
        now,
      })
      if (advice) {
        await nudge()
        return { runOpened: true, ...advice }
      }
      const { message, plan } = await decide(db, context, messageId, run.id)
      if (plan.kind === 'schedule') {
        let body: string
        try {
          body = renderScheduleDraft(plan, nextScheduleTimes(plan.cron, now))
        } catch {
          await enqueueNotification(db, {
            kind: 'system',
            dedupeKey: `browser:intake:${message.id}:unclear`,
            body: 'Please specify a valid schedule at least one hour apart in Asia/Kolkata, using one minute value per hour.',
            runId: run.id,
          })
          await nudge()
          return { runOpened: true, outcome: 'unclear' }
        }
        await enqueueNotification(db, {
          kind: 'system',
          deliveryPolicy: 'at_least_once',
          dedupeKey: `browser:intake:${message.id}:schedule`,
          body,
          runId: run.id,
          expiresAt: new Date(message.createdAt.getTime() + SCHEDULE_DRAFT_TTL_MS),
          payload: {
            browserScheduleDraft: { version: 1, messageId: message.id },
            inlineButtons: [
              [
                { text: 'Save', callbackData: 'bs:save' },
                { text: 'Cancel', callbackData: 'bs:cancel' },
              ],
            ],
          },
        })
        await nudge()
        return { runOpened: true, outcome: 'schedule' }
      }
      if (plan.kind === 'invalid' || plan.kind === 'unclear') {
        await enqueueNotification(db, {
          kind: 'system',
          dedupeKey: `browser:intake:${message.id}:${plan.kind}`,
          body: plan.kind === 'invalid' ? renderIntakeUsage() : plan.question,
          runId: run.id,
        })
        await nudge()
        return { runOpened: true, outcome: plan.kind }
      }
      const { task, created } = await createBrowserTask(db, {
        source: 'telegram',
        site: plan.site,
        action: plan.action,
        targetUrl: plan.spec.targetUrl,
        instruction: `${plan.action.endsWith('_apply') ? 'Apply with a short note' : plan.action === 'reddit_post' ? 'Post text' : 'Comment'} on ${plan.spec.targetUrl}`,
        spec: plan.spec,
        requestMessageId: message.id,
        confirmationRequired: isStaleRequest(message.payload, now),
      })
      if (task.statusReason === 'confirmation_required') {
        const pending = browserTaskSpecV1.safeParse(task.spec)
        const answerDraft = pending.success && pending.data.composeComment?.answer !== undefined
        const expiresAt = new Date(
          (answerDraft ? task.updatedAt : task.createdAt).getTime() + TASK_DRAFT_TTL_MS,
        )
        await enqueueNotification(db, {
          kind: 'system',
          deliveryPolicy: 'at_least_once',
          dedupeKey: `browser:task:${task.id}:${answerDraft ? 'answer-draft' : 'draft'}`,
          body: renderTaskDraft(task, expiresAt),
          payload: {
            browserTaskDraft: { version: 1, taskId: task.id },
            inlineButtons: draftTaskButtons(task.id),
          },
          runId: run.id,
          expiresAt,
        })
        await nudge()
        return { runOpened: true, outcome: 'draft', taskId: task.id }
      }
      if (task.status === 'queued' && !isTaskPreparationGated(task.statusReason)) {
        await context.boss.send(QUEUES.browserTask.name, {
          taskId: task.id,
        } satisfies BrowserTaskJobData)
        await enqueueQueuedNotice(db, { task, runId: run.id })
        await nudge()
      }
      runLog.info(
        { taskId: task.id, outcome: created ? 'created' : 'existing' },
        'browser task intake complete',
      )
      return { runOpened: true, outcome: created ? 'created' : 'existing', taskId: task.id }
    },
  )
}
