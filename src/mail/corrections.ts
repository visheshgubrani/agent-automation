import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db, DbSession } from '../db/index.js'
import { classificationFeedback, messages, notificationOutbox } from '../db/schema/index.js'
import { emailTriageDedupeKey } from '../notifications/dedupe.js'
import type { NotificationRow } from '../notifications/outbox.js'
import { produceEmailTriageAlert } from './alerts.js'
import {
  loadCurrentClassification,
  recordCorrectionDecisionInTransaction,
} from './classification.js'
import { loadDisplayedClassification } from './review.js'

export class StaleClassificationError extends Error {
  constructor() {
    super('this mail item is out of date; run the review again')
    this.name = 'StaleClassificationError'
  }
}

export class InvalidCorrectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCorrectionError'
  }
}

export interface NotificationCallbackMatch {
  notification: NotificationRow | null
  /** True when a Telegram message id exists but belongs to another classification. */
  conflict: boolean
}

/**
 * Find the outbox row an alert button belongs to. A message id with a different classification
 * is a stale/mismatched callback and must be rejected rather than linked to new feedback.
 */
export async function findNotificationForCallback(
  db: DbSession,
  options: { telegramMessageId: number; classificationId: string },
): Promise<NotificationCallbackMatch> {
  const rows = await db
    .select()
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.kind, 'email_triage'),
        eq(notificationOutbox.telegramMessageId, options.telegramMessageId),
      ),
    )
  const match = rows.find((row) => row.classificationId === options.classificationId)
  if (match) return { notification: match, conflict: false }
  return { notification: null, conflict: rows.length > 0 }
}

/** Cancel only unsent rows; an in-flight send may finish and sent alerts are never rewritten. */
export async function cancelUnsentAlerts(
  db: DbSession,
  dedupeKeys: readonly string[],
  now: Date,
): Promise<number> {
  if (dedupeKeys.length === 0) return 0
  const rows = await db
    .update(notificationOutbox)
    .set({
      status: 'cancelled',
      lastError: 'cancelled by Telegram correction',
      updatedAt: now,
    })
    .where(
      and(
        inArray(notificationOutbox.dedupeKey, [...dedupeKeys]),
        inArray(notificationOutbox.status, ['pending', 'batched']),
      ),
    )
    .returning({ id: notificationOutbox.id })
  return rows.length
}

export interface ApplyCorrectionInput {
  displayedClassificationId: string
  runId: string
  important: boolean
  /** Present only when the callback came from a real alert message. */
  notificationId: string | null
  now?: Date
}

export interface ApplyCorrectionResult {
  affectedCopies: number
  insertedCorrections: number
  cancelledAlerts: number
  notificationOutcomes: string[]
  notificationStatuses: string[]
}

/**
 * Apply one explicit Telegram correction: pin feedback to the displayed classification, apply
 * correction decisions to every stored copy with the same RFC Message-ID, then either produce a
 * missed-important alert (dedupe/reactivation handled by the producer) or cancel eligible unsent
 * alerts. Runs in one transaction; a superseded classification is rejected as stale.
 */
export async function applyMessageCorrection(
  db: Db,
  input: ApplyCorrectionInput,
): Promise<ApplyCorrectionResult> {
  const now = input.now ?? new Date()

  return db.transaction(async (tx) => {
    const displayed = await loadDisplayedClassification(tx, input.displayedClassificationId)
    if (!displayed) {
      throw new InvalidCorrectionError('classification not found')
    }
    if (displayed.classification.supersededAt !== null) {
      const current = await loadCurrentClassification(tx, displayed.message.id)
      const idempotentRepeat =
        current?.decisionSource === 'correction' && current.shouldNotify === input.important
      if (!idempotentRepeat) throw new StaleClassificationError()
    }

    if (input.notificationId !== null) {
      const [notification] = await tx
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.id, input.notificationId))
        .limit(1)
      if (
        notification?.kind !== 'email_triage' ||
        notification.classificationId !== input.displayedClassificationId
      ) {
        throw new InvalidCorrectionError('notification does not belong to this classification')
      }
    }

    const rating = input.important ? 'useful' : 'not_useful'
    const reason = input.important
      ? displayed.classification.shouldNotify
        ? 'other'
        : 'missed_important'
      : displayed.classification.shouldNotify
        ? 'too_noisy'
        : 'other'
    const note = input.important
      ? 'Marked important from Telegram'
      : 'Marked not important from Telegram'

    await tx
      .insert(classificationFeedback)
      .values({
        classificationId: input.displayedClassificationId,
        notificationId: input.notificationId,
        rating,
        reason,
        note,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: classificationFeedback.classificationId,
        set: {
          // A review callback has no notification context; keep an existing valid link.
          notificationId: sql`coalesce(excluded.notification_id, ${classificationFeedback.notificationId})`,
          rating,
          reason,
          note,
          updatedAt: now,
        },
      })

    // Lock the canonical copies so an in-flight classification cannot race the correction.
    const canonicalMessages = displayed.message.rfcMessageId
      ? await tx
          .select()
          .from(messages)
          .where(eq(messages.rfcMessageId, displayed.message.rfcMessageId))
          .orderBy(messages.id)
          .for('update')
      : await tx.select().from(messages).where(eq(messages.id, displayed.message.id)).for('update')

    const copies = canonicalMessages.length > 0 ? canonicalMessages : [displayed.message]
    const corrections: {
      messageId: string
      classification: Awaited<
        ReturnType<typeof recordCorrectionDecisionInTransaction>
      >['classification']
      inserted: boolean
    }[] = []

    for (const copy of copies) {
      const current = await loadCurrentClassification(tx, copy.id)
      const result = await recordCorrectionDecisionInTransaction(tx, {
        messageId: copy.id,
        runId: input.runId,
        shouldNotify: input.important,
        topic: current?.topic ?? 'other',
        summary: current?.summary ?? null,
        reason: input.important
          ? 'Marked important from Telegram'
          : 'Marked not important from Telegram',
        now,
      })
      corrections.push({
        messageId: copy.id,
        classification: result.classification,
        inserted: result.inserted,
      })
    }

    let cancelledAlerts = 0
    const notificationOutcomes: string[] = []
    const notificationStatuses: string[] = []

    if (input.important) {
      for (const correction of corrections) {
        const outcome = await produceEmailTriageAlert(tx, {
          messageId: correction.messageId,
          classification: {
            id: correction.classification.id,
            shouldNotify: true,
            summary: correction.classification.summary,
            reason: correction.classification.reason,
          },
          allowBeforeBoundary: true,
        })
        notificationOutcomes.push(outcome.outcome)
        if (outcome.notification) notificationStatuses.push(outcome.notification.status)
      }
    } else {
      const dedupeKeys = new Set<string>()
      if (displayed.message.rfcMessageId !== null) {
        dedupeKeys.add(
          emailTriageDedupeKey({
            rfcMessageId: displayed.message.rfcMessageId,
            messageId: displayed.message.id,
          }),
        )
      } else {
        dedupeKeys.add(
          emailTriageDedupeKey({
            rfcMessageId: null,
            messageId: displayed.message.id,
          }),
        )
      }
      cancelledAlerts = await cancelUnsentAlerts(tx, [...dedupeKeys], now)
    }

    return {
      affectedCopies: copies.length,
      insertedCorrections: corrections.filter((row) => row.inserted).length,
      cancelledAlerts,
      notificationOutcomes,
      notificationStatuses,
    }
  })
}
