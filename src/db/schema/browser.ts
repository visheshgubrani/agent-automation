import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { approvals } from './approvals.js'
import {
  artifactKind,
  browserHandoffReason,
  browserHandoffStatus,
  browserTaskSource,
  browserTaskStatus,
} from './enums.js'
import { notificationOutbox } from './notifications.js'
import { runs } from './runs.js'
import { telegramMessages } from './telegram.js'
import { timestamps } from './types.js'

/** Bounds shared with the application contracts in `src/agent/contracts.ts`. */
export const BROWSER_TASK_INSTRUCTION_MAX_CHARS = 4_000
export const BROWSER_TASK_URL_MAX_CHARS = 2_048
export const BROWSER_STATUS_REASON_MAX_CHARS = 64
export const BROWSER_HANDOFF_DETAIL_MAX_CHARS = 1_000

export const browserSchedules = pgTable(
  'browser_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    instruction: text('instruction').notNull(),
    site: text('site').notNull(),
    action: text('action').notNull(),
    specTemplate: jsonb('spec_template').$type<Record<string, unknown>>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdFromMessageId: uuid('created_from_message_id').references(() => telegramMessages.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    check(
      'browser_schedules_bounds_check',
      sql`char_length(${t.cron}) between 1 and 120 and char_length(${t.instruction}) <= 4000`,
    ),
    check('browser_schedules_timezone_check', sql`${t.timezone} = 'Asia/Kolkata'`),
    index('browser_schedules_due_idx').on(t.nextRunAt).where(sql`${t.enabled}`),
    uniqueIndex('browser_schedules_message_uq')
      .on(t.createdFromMessageId)
      .where(sql`${t.createdFromMessageId} is not null`),
  ],
)

/**
 * One requested browser action (phase 05, D042). `spec` holds the pinned field values and
 * their provenance before any web content is read. Transitions are conditional updates in
 * application code; the checks below keep terminal/active timestamps honest.
 */
export const browserTasks = pgTable(
  'browser_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: browserTaskSource('source').notNull(),
    scheduleId: uuid('schedule_id').references(() => browserSchedules.id, { onDelete: 'restrict' }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    requestMessageId: uuid('request_message_id').references(() => telegramMessages.id, {
      onDelete: 'set null',
    }),
    retryOfTaskId: uuid('retry_of_task_id').references((): AnyPgColumn => browserTasks.id, {
      onDelete: 'set null',
    }),
    // The browser_task run; null until the job starts the task.
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'restrict' }),
    // Validated against the site registry in code, so open text rather than enums.
    site: text('site').notNull(),
    action: text('action').notNull(),
    targetUrl: text('target_url').notNull(),
    instruction: text('instruction').notNull().default(''),
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
    status: browserTaskStatus('status').notNull().default('queued'),
    // Open catalog (interrupted, approval_expired, budget_exhausted, ...); bounded.
    statusReason: text('status_reason'),
    approvalId: uuid('approval_id').references(() => approvals.id, { onDelete: 'restrict' }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    // Bounded evidence only: result URL and screenshot artifact id. Never page bodies.
    result: jsonb('result').$type<Record<string, unknown>>(),
    cdpTargetId: text('cdp_target_id'),
    bossJobId: uuid('boss_job_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      'browser_tasks_schedule_pair_check',
      sql`(${t.scheduleId} is null) = (${t.scheduledFor} is null)`,
    ),
    uniqueIndex('browser_tasks_schedule_slot_uq')
      .on(t.scheduleId, t.scheduledFor)
      .where(sql`${t.scheduleId} is not null`),
    check(
      'browser_tasks_active_finished_check',
      sql`(${t.status} in ('queued', 'running', 'waiting_for_human', 'awaiting_approval', 'executing'))
        = (${t.finishedAt} is null)`,
    ),
    check(
      'browser_tasks_submitted_check',
      sql`${t.status} not in ('succeeded', 'unverified', 'outcome_unknown')
        or ${t.submittedAt} is not null`,
    ),
    check(
      'browser_tasks_retry_not_self_check',
      sql`${t.retryOfTaskId} is null or ${t.retryOfTaskId} <> ${t.id}`,
    ),
    check(
      'browser_tasks_bounds_check',
      sql`char_length(${t.instruction}) <= ${sql.raw(String(BROWSER_TASK_INSTRUCTION_MAX_CHARS))}
        and char_length(${t.targetUrl}) between 1 and ${sql.raw(String(BROWSER_TASK_URL_MAX_CHARS))}
        and (${t.statusReason} is null
          or char_length(${t.statusReason}) between 1 and ${sql.raw(String(BROWSER_STATUS_REASON_MAX_CHARS))})`,
    ),
    // One browser task holds the browser at a time.
    uniqueIndex('browser_tasks_one_active_uq')
      .on(sql`(true)`)
      .where(
        sql`${t.status} in ('running', 'waiting_for_human', 'awaiting_approval', 'executing')`,
      ),
    // Intake idempotency for replayed Telegram messages (D046).
    uniqueIndex('browser_tasks_request_message_uq')
      .on(t.requestMessageId)
      .where(sql`${t.requestMessageId} is not null`),
    // Startup recovery and the queue scan.
    index('browser_tasks_open_status_created_idx')
      .on(t.status, t.createdAt)
      .where(
        sql`${t.status} in ('queued', 'running', 'waiting_for_human', 'awaiting_approval', 'executing')`,
      ),
    // `/tasks` recent list.
    index('browser_tasks_created_idx').on(t.createdAt.desc()),
    // Per-site daily caps.
    index('browser_tasks_submitted_idx')
      .on(t.site, t.action, t.submittedAt)
      .where(sql`${t.submittedAt} is not null`),
    index('browser_tasks_approval_idx').on(t.approvalId).where(sql`${t.approvalId} is not null`),
  ],
)

/**
 * Stored files referenced by tasks and Telegram cards. Content-addressed by sha256 under
 * `ARTIFACT_DIR`; `storage_path` is relative and retention tombstones with `deleted_at`.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: artifactKind('kind').notNull(),
    taskId: uuid('task_id').references(() => browserTasks.id, { onDelete: 'set null' }),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    byteSize: integer('byte_size').notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('artifacts_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('artifacts_byte_size_check', sql`${t.byteSize} > 0`),
    // Relative to ARTIFACT_DIR: no absolute paths and no parent-directory segments.
    check(
      'artifacts_storage_path_check',
      sql`${t.storagePath} <> '' and ${t.storagePath} !~ '^/' and ${t.storagePath} !~ '(^|/)\\.\\.(/|$)'`,
    ),
    uniqueIndex('artifacts_kind_sha256_uq').on(t.kind, t.sha256),
    // Retention sweep.
    index('artifacts_live_created_idx').on(t.createdAt).where(sql`${t.deletedAt} is null`),
    index('artifacts_task_idx').on(t.taskId).where(sql`${t.taskId} is not null`),
  ],
)

/**
 * A pause for the user to fix a captcha, login, 2FA, or verification page over the phone
 * view (D047). At most one handoff per task is waiting at a time.
 */
export const browserHandoffs = pgTable(
  'browser_handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => browserTasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    reason: browserHandoffReason('reason').notNull(),
    detail: text('detail'),
    pageUrl: text('page_url'),
    screenshotArtifactId: uuid('screenshot_artifact_id').references(() => artifacts.id, {
      onDelete: 'set null',
    }),
    notificationId: uuid('notification_id').references(() => notificationOutbox.id, {
      onDelete: 'set null',
    }),
    status: browserHandoffStatus('status').notNull().default('waiting'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    // `update:<telegram update id>` for a Done/Stop tap; null for system resolutions.
    resolverRef: text('resolver_ref'),
  },
  (t) => [
    check(
      'browser_handoffs_waiting_resolved_check',
      sql`(${t.status} = 'waiting') = (${t.resolvedAt} is null)`,
    ),
    check('browser_handoffs_expiry_check', sql`${t.expiresAt} > ${t.requestedAt}`),
    check(
      'browser_handoffs_bounds_check',
      sql`(${t.detail} is null or char_length(${t.detail}) <= ${sql.raw(String(BROWSER_HANDOFF_DETAIL_MAX_CHARS))})
        and (${t.pageUrl} is null or char_length(${t.pageUrl}) <= ${sql.raw(String(BROWSER_TASK_URL_MAX_CHARS))})`,
    ),
    uniqueIndex('browser_handoffs_one_waiting_uq').on(t.taskId).where(sql`${t.status} = 'waiting'`),
    index('browser_handoffs_task_idx').on(t.taskId),
  ],
)

export type BrowserTaskRow = typeof browserTasks.$inferSelect
export type BrowserScheduleRow = typeof browserSchedules.$inferSelect
export type BrowserHandoffRow = typeof browserHandoffs.$inferSelect
export type ArtifactRow = typeof artifacts.$inferSelect
