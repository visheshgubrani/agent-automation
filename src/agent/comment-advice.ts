/** Narrow reply context for one Reddit drafting question; no general chat history. */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { fromDrizzle, type PgBoss } from 'pg-boss'
import { z } from 'zod'
import type { Db } from '../db/index.js'
import { browserTasks, notificationOutbox, telegramMessages } from '../db/schema/index.js'
import { enqueueNotification } from '../notifications/outbox.js'
import { QUEUES } from '../queue.js'
import {
  BROWSER_FIELD_VALUE_MAX_CHARS,
  type BrowserTaskSpecV1,
  browserTaskSpecV1,
} from './contracts.js'
import { isStaleRequest } from './intake.js'
import {
  draftTaskButtons,
  renderCommentAdviceCard,
  renderCommentAdviceReply,
  renderTaskDraft,
  stopButton,
} from './render.js'

const adviceMetadata = z.object({ version: z.literal(1), taskId: z.uuid() }).strict()
const ANSWER_START_TTL_MS = 30 * 60_000
type AdviceReplyResult = { outcome: 'existing' | 'created' | 'draft' | 'unclear'; taskId?: string }

export async function pauseForCommentAdvice(
  db: Db,
  options: {
    taskId: string
    runId: string
    spec: BrowserTaskSpecV1
    question: string
    now: Date
  },
): Promise<void> {
  const request = options.spec.composeComment
  if (!request || request.question || request.answer)
    throw new Error('A comment can ask only one question.')
  const spec = browserTaskSpecV1.parse({
    ...options.spec,
    composeComment: {
      ...request,
      question: options.question,
      priorRunIds: [...new Set([...request.priorRunIds, options.runId])],
    },
  })
  await db.transaction(async (tx) => {
    const [task] = await tx
      .update(browserTasks)
      .set({
        spec,
        status: 'queued',
        statusReason: 'advice_required',
        updatedAt: options.now,
      })
      .where(
        and(
          eq(browserTasks.id, options.taskId),
          eq(browserTasks.status, 'running'),
          isNull(browserTasks.cancelRequestedAt),
        ),
      )
      .returning()
    if (!task) throw new Error('The task stopped before its question was saved.')
    await enqueueNotification(tx, {
      kind: 'system',
      deliveryPolicy: 'at_least_once',
      dedupeKey: `browser:task:${task.id}:advice`,
      runId: options.runId,
      body: renderCommentAdviceCard(task.id, options.question),
      payload: {
        browserCommentAdvice: { version: 1, taskId: task.id },
        inlineButtons: [[stopButton(task.id)]],
      },
    })
  })
}

/** Undefined means an ordinary message; a recognised but stale reply never reaches general intake. */
export async function consumeCommentAdvice(
  db: Db,
  options: {
    messageId: string
    runId: string
    boss: PgBoss
    now: Date
  },
): Promise<AdviceReplyResult | undefined> {
  return db
    .transaction<AdviceReplyResult | undefined>(async (tx) => {
      const [message] = await tx
        .select()
        .from(telegramMessages)
        .where(eq(telegramMessages.id, options.messageId))
        .for('update')
        .limit(1)
      if (
        message?.direction !== 'inbound' ||
        !message.replyToTelegramMessageId ||
        message.text.trimStart().startsWith('/')
      )
        return undefined
      const [card] = await tx
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.telegramMessageId, message.replyToTelegramMessageId))
        .limit(1)
      const metadata = adviceMetadata.safeParse(card?.payload?.browserCommentAdvice)
      if (!metadata.success || !card) return undefined
      if (message.payload.browserCommentAdviceConsumed)
        return { outcome: 'existing', taskId: metadata.data.taskId }
      const [task] = await tx
        .select()
        .from(browserTasks)
        .where(eq(browserTasks.id, metadata.data.taskId))
        .for('update')
        .limit(1)
      let requestMessageId = task?.requestMessageId
      let previousTaskId = task?.retryOfTaskId
      for (let depth = 0; !requestMessageId && previousTaskId && depth < 32; depth++) {
        const [previous] = await tx
          .select({
            requestMessageId: browserTasks.requestMessageId,
            retryOfTaskId: browserTasks.retryOfTaskId,
          })
          .from(browserTasks)
          .where(eq(browserTasks.id, previousTaskId))
          .limit(1)
        requestMessageId = previous?.requestMessageId
        previousTaskId = previous?.retryOfTaskId
      }
      const [original] = requestMessageId
        ? await tx
            .select({ chatId: telegramMessages.chatId })
            .from(telegramMessages)
            .where(eq(telegramMessages.id, requestMessageId))
            .limit(1)
        : []
      const spec = browserTaskSpecV1.safeParse(task?.spec)
      const answer = message.text.trim()
      const valid =
        card.status === 'sent' &&
        card.dedupeKey === `browser:task:${task?.id}:advice` &&
        original?.chatId === message.chatId &&
        task?.status === 'queued' &&
        task.statusReason === 'advice_required' &&
        spec.success &&
        spec.data.composeComment?.question &&
        !spec.data.composeComment.answer
      if (!valid || !answer || answer.length > BROWSER_FIELD_VALUE_MAX_CHARS) {
        await enqueueNotification(tx, {
          kind: 'system',
          dedupeKey: `browser:advice-answer:${message.id}:invalid`,
          runId: options.runId,
          body: renderCommentAdviceReply(valid ? 'invalid' : 'stale'),
        })
        return { outcome: 'unclear' }
      }
      // Narrowing above uses a boolean; reassert the validated contract for TypeScript.
      if (!task || !spec.success || !spec.data.composeComment)
        throw new Error('Missing comment request.')
      const updatedSpec = browserTaskSpecV1.parse({
        ...spec.data,
        composeComment: { ...spec.data.composeComment, answer },
      })
      const stale = isStaleRequest(message.payload, options.now)
      const [resumed] = await tx
        .update(browserTasks)
        .set({
          spec: updatedSpec,
          statusReason: stale ? 'confirmation_required' : null,
          updatedAt: options.now,
        })
        .where(eq(browserTasks.id, task.id))
        .returning()
      if (!resumed) throw new Error('Missing resumed comment task.')
      await tx
        .update(telegramMessages)
        .set({ payload: { ...message.payload, browserCommentAdviceConsumed: { taskId: task.id } } })
        .where(eq(telegramMessages.id, message.id))
      if (stale) {
        const expiresAt = new Date(options.now.getTime() + ANSWER_START_TTL_MS)
        await enqueueNotification(tx, {
          kind: 'system',
          deliveryPolicy: 'at_least_once',
          dedupeKey: `browser:task:${task.id}:answer-draft`,
          body: renderTaskDraft(resumed, expiresAt),
          runId: options.runId,
          expiresAt,
          payload: {
            browserTaskDraft: { version: 1, taskId: task.id },
            inlineButtons: draftTaskButtons(task.id),
          },
        })
      } else {
        const jobId = await options.boss.send(
          QUEUES.browserTask.name,
          { taskId: task.id },
          { db: fromDrizzle(tx, sql) },
        )
        if (!jobId) throw new Error('Could not queue the comment answer.')
        await enqueueNotification(tx, {
          kind: 'system',
          dedupeKey: `browser:task:${task.id}:answer`,
          runId: options.runId,
          body: renderCommentAdviceReply('accepted'),
        })
      }
      return { outcome: stale ? 'draft' : 'created', taskId: task.id }
    })
    .catch(() => {
      // Database/queue errors can contain the answer in query parameters.
      throw new Error('Could not save or queue the comment answer; please reply again.')
    })
}
