import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { toneSampleSource, watchlistKind } from './enums.js'
import { timestamps } from './types.js'

/** Single-user settings. One row, id = 1; the app upserts it. */
export const userSettings = pgTable(
  'user_settings',
  {
    id: smallint('id').primaryKey().default(1),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    // Wall-clock quiet hours in `timezone`; may cross midnight. Not instants, so `time`.
    quietHoursStart: time('quiet_hours_start'),
    quietHoursEnd: time('quiet_hours_end'),
    quietHoursAllowUrgent: boolean('quiet_hours_allow_urgent').notNull().default(true),
    // Null means batching is disabled (the phase 03 initial behavior).
    batchWindowMinutes: integer('batch_window_minutes'),
    approvalTtlMinutes: integer('approval_ttl_minutes').notNull().default(1440),
    // Nullable so an explicit null can still mean "no limit"; the initial default is $1/day.
    dailySpendLimitUsd: numeric('daily_spend_limit_usd', { precision: 10, scale: 2 }).default(
      '1.00',
    ),
    ...timestamps(),
  },
  (t) => [
    check('user_settings_singleton_check', sql`${t.id} = 1`),
    check(
      'user_settings_quiet_hours_pair_check',
      sql`(${t.quietHoursStart} is null) = (${t.quietHoursEnd} is null)`,
    ),
    check(
      'user_settings_batch_window_check',
      sql`${t.batchWindowMinutes} is null or ${t.batchWindowMinutes} > 0`,
    ),
    check('user_settings_approval_ttl_check', sql`${t.approvalTtlMinutes} > 0`),
    check(
      'user_settings_spend_limit_check',
      sql`${t.dailySpendLimitUsd} is null or ${t.dailySpendLimitUsd} >= 0`,
    ),
  ],
)

/** VIP senders apply across every inbox. */
export const vipSenders = pgTable(
  'vip_senders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    note: text('note'),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('vip_senders_email_lower_uq').on(sql`lower(${t.email})`)],
)

/** Explicit market entities used by digest relevance scoring later. */
export const watchlistItems = pgTable(
  'watchlist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: watchlistKind('kind').notNull(),
    value: text('value').notNull(),
    label: text('label'),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('watchlist_items_kind_value_lower_uq').on(t.kind, sql`lower(${t.value})`)],
)

/** Broader subjects; scoring weights stay in code until the digest phase. */
export const interests = pgTable(
  'interests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topic: text('topic').notNull(),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('interests_topic_lower_uq').on(sql`lower(${t.topic})`)],
)

/** Writing-style references for later drafting; embeddings attach later by UUID. */
export const toneSamples = pgTable('tone_samples', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  content: text('content').notNull(),
  source: toneSampleSource('source').notNull().default('manual'),
  active: boolean('active').notNull().default(true),
  ...timestamps(),
})
