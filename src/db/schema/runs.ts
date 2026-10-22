import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { runKind, runStatus, runTrigger } from './enums.js'

/**
 * Audit root. Every job attempt, LLM call, tool call, approval, and notification links
 * back to a run (directly or through a child) so a job can be traced end to end.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: runKind('kind').notNull(),
    trigger: runTrigger('trigger').notNull(),
    status: runStatus('status').notNull().default('running'),
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => runs.id, {
      onDelete: 'set null',
    }),
    bossJobId: uuid('boss_job_id'),
    // Ids/references only; never secrets or full untrusted content.
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('runs_status_finished_check', sql`(${t.status} = 'running') = (${t.finishedAt} is null)`),
    check(
      'runs_finished_after_started_check',
      sql`${t.finishedAt} is null or ${t.finishedAt} >= ${t.startedAt}`,
    ),
    check(
      'runs_parent_not_self_check',
      sql`${t.parentRunId} is null or ${t.parentRunId} <> ${t.id}`,
    ),
    index('runs_kind_started_idx').on(t.kind, t.startedAt.desc()),
    index('runs_running_started_idx').on(t.startedAt).where(sql`${t.status} = 'running'`),
    index('runs_parent_run_idx').on(t.parentRunId).where(sql`${t.parentRunId} is not null`),
    index('runs_boss_job_idx').on(t.bossJobId).where(sql`${t.bossJobId} is not null`),
  ],
)
