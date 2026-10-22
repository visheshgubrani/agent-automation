import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { approvals } from './approvals.js'
import {
  feedbackRating,
  feedbackReason,
  notificationChannel,
  notificationDeliveryPolicy,
  notificationKind,
  notificationStatus,
} from './enums.js'
import { emailClassifications } from './mail.js'
import { runs } from './runs.js'

/**
 * The single proactive delivery outbox. dedupe_key is globally unique for the single user.
 * For email notifications the key is derived from the RFC Message-ID when present so the
 * same email arriving in two inboxes collapses to one notification.
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: notificationKind('kind').notNull(),
    channel: notificationChannel('channel').notNull().default('telegram'),
    status: notificationStatus('status').notNull().default('pending'),
    // Snapshot of the kind → policy mapping at insert time (D021): the dispatcher and
    // recovery paths branch on this column, never on kind.
    deliveryPolicy: notificationDeliveryPolicy('delivery_policy').notNull().default('at_most_once'),
    dedupeKey: text('dedupe_key').notNull(),
    batchKey: text('batch_key'),
    body: text('body').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    classificationId: uuid('classification_id').references(() => emailClassifications.id, {
      onDelete: 'restrict',
    }),
    approvalId: uuid('approval_id').references(() => approvals.id, { onDelete: 'restrict' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('notification_outbox_dedupe_key_uq').on(t.dedupeKey),
    check('notification_outbox_attempts_check', sql`${t.attemptCount} >= 0`),
    check(
      'notification_outbox_sent_at_check',
      sql`(${t.status} = 'sent') = (${t.sentAt} is not null)`,
    ),
    check(
      'notification_outbox_expires_check',
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.createdAt}`,
    ),
    check(
      'notification_outbox_kind_context_check',
      sql`(
        (${t.kind} = 'email_triage' and ${t.classificationId} is not null and ${t.approvalId} is null)
        or (${t.kind} = 'approval_request' and ${t.approvalId} is not null and ${t.classificationId} is null)
        or (${t.kind} = 'system' and ${t.classificationId} is null and ${t.approvalId} is null)
      )`,
    ),
    index('notification_outbox_due_idx')
      .on(t.scheduledFor)
      .where(sql`${t.status} in ('pending', 'batched')`),
    index('notification_outbox_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} in ('pending', 'batched') and ${t.expiresAt} is not null`),
    index('notification_outbox_approval_idx')
      .on(t.approvalId)
      .where(sql`${t.approvalId} is not null`),
    index('notification_outbox_run_idx').on(t.runId).where(sql`${t.runId} is not null`),
  ],
)

/**
 * One label per classification. The notification link is optional: an email that was
 * ignored can be flagged as missed_important later, even if it was never notified.
 */
export const classificationFeedback = pgTable(
  'classification_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    classificationId: uuid('classification_id')
      .notNull()
      .references(() => emailClassifications.id, { onDelete: 'cascade' }),
    notificationId: uuid('notification_id').references(() => notificationOutbox.id, {
      onDelete: 'set null',
    }),
    rating: feedbackRating('rating').notNull(),
    reason: feedbackReason('reason'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('classification_feedback_classification_uq').on(t.classificationId),
    uniqueIndex('classification_feedback_notification_uq')
      .on(t.notificationId)
      .where(sql`${t.notificationId} is not null`),
  ],
)
