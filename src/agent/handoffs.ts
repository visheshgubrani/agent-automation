/** Durable human pauses (D047). Task locks serialize Done, Stop, expiry, and resumption. */
import { setTimeout as sleep } from 'node:timers/promises'
import { and, count, eq, gt } from 'drizzle-orm'
import { artifactPhotoRef } from '../browser/artifacts.js'
import type { Db, DbSession } from '../db/index.js'
import { type BrowserHandoffRow, browserHandoffs, browserTasks } from '../db/schema/index.js'
import { enqueueNotification } from '../notifications/outbox.js'
import type { BrowserToolHooks, HumanOutcome } from './browser-tools.js'
import { handoffButtons, renderHandoffCard } from './render.js'

export const MAX_HANDOFFS_PER_TASK = 3
export const HANDOFF_POLL_MS = 1_000

export function handoffDedupeKey(handoffId: string): string {
  return `browser:handoff:${handoffId}`
}

export async function createHandoff(
  db: Db,
  input: Parameters<BrowserToolHooks['requestHuman']>[0] & {
    taskId: string
    runId: string
    viewUrl: string
    expiresAt: Date
    now: Date
  },
): Promise<
  { outcome: 'created'; handoff: BrowserHandoffRow } | { outcome: 'cancelled' | 'limit_reached' }
> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, input.taskId))
      .for('update')
      .limit(1)
    if (task?.status !== 'running' || task.cancelRequestedAt !== null)
      return { outcome: 'cancelled' }
    const [used] = await tx
      .select({ total: count() })
      .from(browserHandoffs)
      .where(eq(browserHandoffs.taskId, task.id))
    if ((used?.total ?? 0) >= MAX_HANDOFFS_PER_TASK) return { outcome: 'limit_reached' }

    const [handoff] = await tx
      .insert(browserHandoffs)
      .values({
        taskId: task.id,
        runId: input.runId,
        reason: input.reason,
        detail: input.detail.slice(0, 300),
        pageUrl: input.pageUrl.slice(0, 2_048),
        screenshotArtifactId: input.screenshotArtifactId,
        requestedAt: input.now,
        expiresAt: input.expiresAt,
      })
      .returning()
    if (!handoff) throw new Error('createHandoff did not return a row')
    const photo = await artifactPhotoRef(tx, input.screenshotArtifactId)
    const { notification } = await enqueueNotification(tx, {
      kind: 'system',
      deliveryPolicy: 'at_least_once',
      dedupeKey: handoffDedupeKey(handoff.id),
      body: renderHandoffCard(task, handoff, input.viewUrl),
      payload: {
        ...(photo ? { photo } : {}),
        inlineButtons: handoffButtons(task.id, handoff.id, input.viewUrl),
      },
      runId: input.runId,
      expiresAt: input.expiresAt,
    })
    const [linked] = await tx
      .update(browserHandoffs)
      .set({ notificationId: notification.id })
      .where(eq(browserHandoffs.id, handoff.id))
      .returning()
    await tx
      .update(browserTasks)
      .set({ status: 'waiting_for_human', updatedAt: input.now })
      .where(eq(browserTasks.id, task.id))
    return { outcome: 'created', handoff: linked ?? handoff }
  })
}

/** Only the linked delivered card may resolve this exact, unexpired handoff once. */
export async function completeHandoff(
  db: Db,
  input: {
    handoffId: string
    notificationId: string
    resolverRef: string
    now?: Date
  },
): Promise<boolean> {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [handoff] = await tx
      .select()
      .from(browserHandoffs)
      .where(eq(browserHandoffs.id, input.handoffId))
      .limit(1)
    if (!handoff || handoff.notificationId !== input.notificationId) return false
    const [task] = await tx
      .select()
      .from(browserTasks)
      .where(eq(browserTasks.id, handoff.taskId))
      .for('update')
      .limit(1)
    if (task?.status !== 'waiting_for_human' || task.cancelRequestedAt !== null) return false
    const rows = await tx
      .update(browserHandoffs)
      .set({ status: 'resolved', resolvedAt: now, resolverRef: input.resolverRef })
      .where(
        and(
          eq(browserHandoffs.id, handoff.id),
          eq(browserHandoffs.status, 'waiting'),
          gt(browserHandoffs.expiresAt, now),
        ),
      )
      .returning({ id: browserHandoffs.id })
    return rows.length > 0
  })
}

export async function cancelWaitingHandoffs(
  db: DbSession,
  input: {
    taskId: string
    now: Date
    resolverRef?: string
  },
): Promise<void> {
  await db
    .update(browserHandoffs)
    .set({ status: 'cancelled', resolvedAt: input.now, resolverRef: input.resolverRef ?? null })
    .where(and(eq(browserHandoffs.taskId, input.taskId), eq(browserHandoffs.status, 'waiting')))
}

/** Resume only after Done; system exits close the handoff and task in the same transaction. */
export async function waitForHandoff(options: {
  db: Db
  taskId: string
  handoffId: string
  signal?: AbortSignal
  pollMs?: number
  now?: () => Date
}): Promise<HumanOutcome> {
  const { db, signal } = options
  while (true) {
    const now = options.now?.() ?? new Date()
    const outcome = await db.transaction(async (tx): Promise<HumanOutcome | undefined> => {
      const [task] = await tx
        .select()
        .from(browserTasks)
        .where(eq(browserTasks.id, options.taskId))
        .for('update')
        .limit(1)
      const [handoff] = await tx
        .select()
        .from(browserHandoffs)
        .where(
          and(
            eq(browserHandoffs.id, options.handoffId),
            eq(browserHandoffs.taskId, options.taskId),
          ),
        )
        .limit(1)
      if (!task || !handoff) return 'cancelled'
      if (task.status !== 'waiting_for_human') {
        return task.statusReason === 'interrupted' ? 'interrupted' : 'cancelled'
      }
      const terminal =
        task.cancelRequestedAt !== null
          ? 'cancelled'
          : signal?.aborted
            ? 'interrupted'
            : handoff.status === 'waiting' && now >= handoff.expiresAt
              ? 'timed_out'
              : undefined
      if (terminal) {
        await tx
          .update(browserHandoffs)
          .set({ status: terminal, resolvedAt: now })
          .where(and(eq(browserHandoffs.id, handoff.id), eq(browserHandoffs.status, 'waiting')))
        await tx
          .update(browserTasks)
          .set({
            status: terminal === 'cancelled' ? 'cancelled' : 'failed',
            statusReason:
              terminal === 'cancelled'
                ? 'cancelled_by_user'
                : terminal === 'timed_out'
                  ? 'handoff_timeout'
                  : 'interrupted',
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(browserTasks.id, task.id))
        return terminal
      }
      if (handoff.status === 'resolved') {
        await tx
          .update(browserTasks)
          .set({ status: 'running', updatedAt: now })
          .where(eq(browserTasks.id, task.id))
        return 'resolved'
      }
      if (handoff.status !== 'waiting') return handoff.status
      return undefined
    })
    if (outcome) return outcome
    await sleep(options.pollMs ?? HANDOFF_POLL_MS, undefined, { signal }).catch(
      (error: unknown) => {
        if (!signal?.aborted) throw error
      },
    )
  }
}
