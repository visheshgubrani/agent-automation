import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { Db, DbSession } from '../db/index.js'
import {
  type notificationChannel,
  type notificationDeliveryPolicy,
  type notificationKind,
  notificationOutbox,
} from '../db/schema/index.js'

export type NotificationKind = (typeof notificationKind.enumValues)[number]
export type NotificationChannel = (typeof notificationChannel.enumValues)[number]
export type DeliveryPolicy = (typeof notificationDeliveryPolicy.enumValues)[number]
export type NotificationRow = typeof notificationOutbox.$inferSelect

/** A row fails permanently after this many send attempts (5th failed attempt, both policies). */
export const MAX_SEND_ATTEMPTS = 5

/** Base retry backoff for safe-to-retry failures; doubles per attempt, capped at 1h. */
export const BASE_BACKOFF_SECONDS = 60
export const MAX_BACKOFF_SECONDS = 3_600

/** A `sending` row older than this is stale (crashed worker); recovery applies its policy. */
export const STALE_SENDING_AFTER_MS = 10 * 60 * 1000

/** Per-kind delivery policy snapshotted onto each row at enqueue time (D021). */
export const KIND_DELIVERY_POLICY = {
  system: 'at_most_once',
  email_triage: 'at_least_once',
  approval_request: 'at_least_once',
} as const satisfies Record<NotificationKind, DeliveryPolicy>

export interface EnqueueNotificationInput {
  kind: NotificationKind
  /** Canonical idempotency key, e.g. `system:heartbeat:<job id>`; globally unique. */
  dedupeKey: string
  body: string
  /** Template data; never message bodies of untrusted content. */
  payload?: Record<string, unknown>
  classificationId?: string
  approvalId?: string
  runId?: string
  scheduledFor?: Date
  expiresAt?: Date
  /** Explicit policy override; defaults to the kind's map entry. */
  deliveryPolicy?: DeliveryPolicy
}

export interface EnqueueResult {
  notification: NotificationRow
  /** False when the dedupe key already existed (e.g. a retried job); nothing was inserted. */
  inserted: boolean
}

/**
 * The only production insert path for `notification_outbox`. Sets the delivery policy from
 * the kind (unless explicitly overridden) and is idempotent on the dedupe key: a retried
 * producer job finds the existing row instead of failing on the unique constraint. Accepts a
 * `DbSession` so a producer can commit its business rows and the outbox row atomically.
 */
export async function enqueueNotification(
  db: DbSession,
  input: EnqueueNotificationInput,
): Promise<EnqueueResult> {
  const deliveryPolicy = input.deliveryPolicy ?? KIND_DELIVERY_POLICY[input.kind]

  const [row] = await db
    .insert(notificationOutbox)
    .values({
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      body: input.body,
      deliveryPolicy,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      ...(input.classificationId !== undefined ? { classificationId: input.classificationId } : {}),
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.scheduledFor !== undefined ? { scheduledFor: input.scheduledFor } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    })
    .onConflictDoNothing({ target: notificationOutbox.dedupeKey })
    .returning()

  if (row) {
    return { notification: row, inserted: true }
  }

  const [existing] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.dedupeKey, input.dedupeKey))
    .limit(1)
  if (!existing) {
    throw new Error(`enqueueNotification lost its dedupe row for key ${input.dedupeKey}`)
  }
  return { notification: existing, inserted: false }
}

/**
 * Find an outbox row by its canonical dedupe key without inserting or changing it.
 * Producers use this to distinguish a real duplicate from a cancelled/undelivered row that an
 * explicit correction may reactivate.
 */
export async function findNotificationByDedupeKey(
  db: DbSession,
  dedupeKey: string,
): Promise<NotificationRow | undefined> {
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.dedupeKey, dedupeKey))
    .limit(1)
  return row
}

function staleSendingColumn() {
  return sql`coalesce(${notificationOutbox.lastAttemptAt}, ${notificationOutbox.updatedAt})`
}

function claimableWhere(channel: NotificationChannel, now: Date) {
  return and(
    inArray(notificationOutbox.status, ['pending', 'batched']),
    eq(notificationOutbox.channel, channel),
    lte(notificationOutbox.scheduledFor, now),
    or(isNull(notificationOutbox.expiresAt), gt(notificationOutbox.expiresAt, now)),
  )
}

/**
 * Claim exactly one due row for sending, in a transaction with `FOR UPDATE SKIP LOCKED` so
 * concurrent workers/ticks never claim the same row. Sets `sending`, increments attempts,
 * and stamps `last_attempt_at` before any Telegram call, so a crash leaves a row that
 * policy-aware recovery can classify.
 */
export async function claimNextDue(
  db: Db,
  options: { channel?: NotificationChannel; now?: Date } = {},
): Promise<NotificationRow | undefined> {
  const now = options.now ?? new Date()
  const channel = options.channel ?? 'telegram'

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(notificationOutbox)
      .where(claimableWhere(channel, now))
      .orderBy(notificationOutbox.scheduledFor)
      .limit(1)
      .for('update', { skipLocked: true })

    if (!candidate) {
      return undefined
    }

    const [claimed] = await tx
      .update(notificationOutbox)
      .set({
        status: 'sending',
        attemptCount: sql`${notificationOutbox.attemptCount} + 1`,
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(eq(notificationOutbox.id, candidate.id))
      .returning()

    return claimed
  })
}

/** Rows that sat past their expiry without being claimed become `expired` (terminal). */
export async function expireDue(db: Db, options: { now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date()
  const rows = await db
    .update(notificationOutbox)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        inArray(notificationOutbox.status, ['pending', 'batched']),
        lte(notificationOutbox.expiresAt, now),
      ),
    )
    .returning({ id: notificationOutbox.id })
  return rows.length
}

export interface RecoveryCounts {
  quarantined: number
  requeued: number
}

/**
 * Recover rows left in `sending` by a crashed worker, by the row's stored delivery policy:
 * at-most-once → `quarantined` (delivery uncertain; possibly sent, never resent);
 * at-least-once → `pending` again (duplicate tolerated). Runs at startup and periodically.
 */
export async function recoverStaleSending(
  db: Db,
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<RecoveryCounts> {
  const now = options.now ?? new Date()
  const staleBefore = new Date(now.getTime() - (options.staleAfterMs ?? STALE_SENDING_AFTER_MS))

  const stale = await db
    .select()
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.status, 'sending'), lt(staleSendingColumn(), staleBefore)))

  const counts: RecoveryCounts = { quarantined: 0, requeued: 0 }
  for (const row of stale) {
    if (row.deliveryPolicy === 'at_most_once') {
      await markQuarantined(
        db,
        row.id,
        'stale sending: delivery uncertain, not resent (at_most_once)',
        now,
      )
      counts.quarantined += 1
    } else {
      await markRetry(db, row.id, {
        reason: 'stale sending: redelivering (at_least_once, duplicate tolerated)',
        delaySeconds: 0,
        now,
      })
      counts.requeued += 1
    }
  }
  return counts
}

/**
 * Retry backoff for an attempt that just failed: `60s * 2^(attempts-1)`, capped at 1h,
 * raised to Telegram's `retry_after` when provided (also capped at 1h).
 */
export function retryDelaySeconds(attemptCount: number, retryAfterSeconds?: number): number {
  const exponential = Math.min(
    MAX_BACKOFF_SECONDS,
    BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attemptCount - 1),
  )
  const floor = Math.min(MAX_BACKOFF_SECONDS, Math.max(0, retryAfterSeconds ?? 0))
  return Math.max(exponential, floor)
}

/** Successful delivery: `sent` + `sent_at` (+ Telegram message id). The DB check ties them. */
export async function markSent(
  db: Db,
  id: string,
  options: { telegramMessageId: number; sentAt?: Date },
): Promise<void> {
  const sentAt = options.sentAt ?? new Date()
  await db
    .update(notificationOutbox)
    .set({
      status: 'sent',
      sentAt,
      telegramMessageId: options.telegramMessageId,
      updatedAt: sentAt,
    })
    .where(eq(notificationOutbox.id, id))
}

/** Schedule a retry: back to `pending` with `scheduled_for` pushed by `delaySeconds`. */
export async function markRetry(
  db: Db,
  id: string,
  options: { reason: string; delaySeconds: number; now?: Date },
): Promise<void> {
  const now = options.now ?? new Date()
  await db
    .update(notificationOutbox)
    .set({
      status: 'pending',
      scheduledFor: new Date(now.getTime() + options.delaySeconds * 1000),
      lastError: options.reason,
      updatedAt: now,
    })
    .where(eq(notificationOutbox.id, id))
}

/** Terminal failure (permanent error or attempts exhausted); visible in the heartbeat. */
export async function markFailed(
  db: Db,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(notificationOutbox)
    .set({ status: 'failed', lastError: reason, updatedAt: now })
    .where(eq(notificationOutbox.id, id))
}

/** Terminal quarantine for at-most-once uncertainty; never auto-resent. */
export async function markQuarantined(
  db: Db,
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(notificationOutbox)
    .set({ status: 'quarantined', lastError: reason, updatedAt: now })
    .where(eq(notificationOutbox.id, id))
}

/**
 * Cheap check for the every-minute dispatch tick: is there due, expired, or stale-sending
 * work? Idle ticks return false and open no run (D020's documented exception).
 */
export async function hasDispatchWork(
  db: Db,
  options: { now?: Date; channel?: NotificationChannel } = {},
): Promise<boolean> {
  const now = options.now ?? new Date()
  const staleBefore = new Date(now.getTime() - STALE_SENDING_AFTER_MS)
  const channel = options.channel ?? 'telegram'

  const [row] = await db
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(
      or(
        claimableWhere(channel, now),
        and(
          inArray(notificationOutbox.status, ['pending', 'batched']),
          lte(notificationOutbox.expiresAt, now),
        ),
        and(eq(notificationOutbox.status, 'sending'), lt(staleSendingColumn(), staleBefore)),
      ),
    )
    .limit(1)
  return row !== undefined
}
