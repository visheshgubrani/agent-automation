import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts.js'
import {
  classificationDecisionSource,
  classificationTopic,
  reasoningEffort,
  triageCategory,
  triageStatus,
} from './enums.js'
import { mailRules } from './rules.js'
import { runs } from './runs.js'

/**
 * A Gmail message. Raw body and cleaned text are deliberately separate: only clean_text and
 * bounded metadata are prompt-facing, while raw_text is retained for provenance/reprocessing.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    providerMessageId: text('provider_message_id').notNull(),
    providerThreadId: text('provider_thread_id'),
    // Normalized Message-ID (no surrounding angle brackets); cross-inbox dedupe.
    rfcMessageId: text('rfc_message_id'),
    fromEmail: text('from_email').notNull(),
    fromName: text('from_name'),
    toEmails: text('to_emails').array().notNull().default(sql`'{}'::text[]`),
    ccEmails: text('cc_emails').array().notNull().default(sql`'{}'::text[]`),
    subject: text('subject').notNull().default(''),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    providerLabels: text('provider_labels').array().notNull().default(sql`'{}'::text[]`),
    // Chosen decoded body as received (plain or HTML), untrusted and never prompt-facing.
    rawText: text('raw_text').notNull(),
    rawContentType: text('raw_content_type').notNull().default('text/plain'),
    cleanText: text('clean_text').notNull().default(''),
    cleanerVersion: smallint('cleaner_version').notNull().default(1),
    // Bounded decoded header map; __attachments holds metadata only, never attachment content.
    headers: jsonb('headers').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    triageStatus: triageStatus('triage_status').notNull().default('pending'),
    triageAttempts: integer('triage_attempts').notNull().default(0),
    triageLastError: text('triage_last_error'),
    // Earliest retry after a transient classification failure; null = not backing off.
    triageNextAttemptAt: timestamp('triage_next_attempt_at', { withTimezone: true }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('messages_account_provider_message_uq').on(t.accountId, t.providerMessageId),
    check('messages_triage_attempts_check', sql`${t.triageAttempts} >= 0`),
    check('messages_cleaner_version_check', sql`${t.cleanerVersion} > 0`),
    index('messages_account_received_idx').on(t.accountId, t.receivedAt.desc()),
    index('messages_from_email_lower_idx').on(sql`lower(${t.fromEmail})`),
    index('messages_triage_pending_idx')
      .on(t.triageStatus, t.receivedAt)
      .where(sql`${t.triageStatus} in ('pending', 'failed')`),
    index('messages_rfc_message_id_idx')
      .on(t.rfcMessageId)
      .where(sql`${t.rfcMessageId} is not null`),
    index('messages_thread_idx')
      .on(t.accountId, t.providerThreadId)
      .where(sql`${t.providerThreadId} is not null`),
    // Supports the on-demand agent's email search tool. Expression must match query code.
    index('messages_fts_idx').using(
      'gin',
      sql`to_tsvector('english', coalesce(${t.subject}, '') || ' ' || ${t.cleanText})`,
    ),
  ],
)

/**
 * Append-only classification output. The partial unique index keeps exactly one current
 * row per message; reclassification inserts a new row and supersedes the old one.
 *
 * `decision_source` keeps rule and correction decisions honest: only classifier rows carry
 * a model/prompt/classifier/confidence snapshot. `should_notify` is the notification decision;
 * `topic` and `category` are independent of it. Rule provenance is the applied rule id.
 */
export const emailClassifications = pgTable(
  'email_classifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    category: triageCategory('category'),
    topic: classificationTopic('topic').notNull().default('other'),
    shouldNotify: boolean('should_notify').notNull().default(false),
    // Null for rule/correction decisions; classifier rows require it.
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    summary: text('summary'),
    reason: text('reason'),
    decisionSource: classificationDecisionSource('decision_source').notNull().default('classifier'),
    appliedRuleId: uuid('applied_rule_id').references(() => mailRules.id, {
      onDelete: 'restrict',
    }),
    // Null for rule/correction decisions; classifier rows snapshot the actual API effort.
    reasoningEffort: reasoningEffort('reasoning_effort'),
    // Null for rule/correction decisions; classifier rows require them.
    model: text('model'),
    promptVersion: text('prompt_version'),
    classifierVersion: text('classifier_version'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('email_classifications_current_uq')
      .on(t.messageId)
      .where(sql`${t.supersededAt} is null`),
    check(
      'email_classifications_confidence_check',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    // Classifier rows carry a real model snapshot; rule/correction rows do not.
    check(
      'email_classifications_decision_source_check',
      sql`(
        (${t.decisionSource} = 'classifier'
          and ${t.category} is not null
          and ${t.model} is not null
          and ${t.promptVersion} is not null
          and ${t.classifierVersion} is not null
          and ${t.confidence} is not null
          and ${t.appliedRuleId} is null)
        or (${t.decisionSource} = 'rule'
          and ${t.category} is null
          and ${t.model} is null
          and ${t.promptVersion} is null
          and ${t.classifierVersion} is null
          and ${t.confidence} is null
          and ${t.reasoningEffort} is null
          and ${t.appliedRuleId} is not null)
        or (${t.decisionSource} = 'correction'
          and ${t.category} is null
          and ${t.model} is null
          and ${t.promptVersion} is null
          and ${t.classifierVersion} is null
          and ${t.confidence} is null
          and ${t.reasoningEffort} is null
          and ${t.appliedRuleId} is null)
      )`,
    ),
    check(
      'email_classifications_superseded_check',
      sql`${t.supersededAt} is null or ${t.supersededAt} >= ${t.createdAt}`,
    ),
    index('email_classifications_run_idx').on(t.runId),
    index('email_classifications_applied_rule_idx')
      .on(t.appliedRuleId)
      .where(sql`${t.appliedRuleId} is not null`),
  ],
)
