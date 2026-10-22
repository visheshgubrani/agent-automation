import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { approvals } from './approvals.js'
import { llmCallStatus, reasoningEffort, riskTier, toolCallStatus } from './enums.js'
import { runs } from './runs.js'

/**
 * One model call attempt. A row is inserted as `in_flight` before the external request with
 * `reserved_cost_usd` (the bounded worst case) so budget admission is durable. It is then
 * finalized to `succeeded`/`failed`, or left `in_flight` if the process dies; recovery marks
 * stale reservations `unknown` and keeps the reserved cost counted. Costs are snapshotted.
 */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    // Open catalog: classify_email, draft_reply, digest_score, agent_chat, ...
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    status: llmCallStatus('status').notNull(),
    // Reasoning effort actually requested for this attempt; null for non-reasoning calls.
    reasoningEffort: reasoningEffort('reasoning_effort'),
    // Worst-case cost reserved durably before the request. Kept after unknown outcomes.
    reservedCostUsd: numeric('reserved_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    // Input tokens written to the provider cache; a subset of promptTokens.
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    // A subset of completionTokens; stored for diagnostics, never added to cost twice.
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms').notNull().default(0),
    providerRequestId: text('provider_request_id'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      'llm_calls_nonnegative_check',
      sql`${t.promptTokens} >= 0
        and ${t.cachedInputTokens} >= 0
        and ${t.cacheWriteTokens} >= 0
        and ${t.completionTokens} >= 0
        and ${t.reasoningTokens} >= 0
        and ${t.reservedCostUsd} >= 0
        and ${t.costUsd} >= 0
        and ${t.latencyMs} >= 0`,
    ),
    index('llm_calls_run_idx').on(t.runId),
    // Daily spend/budget ranges and stale in-flight reservation recovery.
    index('llm_calls_created_at_idx').on(t.createdAt),
    // Narrow recovery scan for unresolved attempts. Uses only the original enum values in
    // the predicate so this DDL is safe in a fresh-database transaction.
    index('llm_calls_unresolved_created_idx')
      .on(t.createdAt)
      .where(sql`${t.status} not in ('succeeded', 'failed')`),
  ],
)

/**
 * One tool invocation. Approved executions pre-insert a running row with approval_id; the
 * unique partial index is the at-most-once claim. args for approved calls are copied from
 * approvals.payload, never re-read from the model.
 */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    riskTier: riskTier('risk_tier').notNull(),
    status: toolCallStatus('status').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    result: jsonb('result').$type<unknown>(),
    error: text('error'),
    approvalId: uuid('approval_id').references(() => approvals.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    latencyMs: integer('latency_ms'),
  },
  (t) => [
    check(
      'tool_calls_status_finished_check',
      sql`(${t.status} = 'running') = (${t.finishedAt} is null)`,
    ),
    check(
      'tool_calls_finished_after_started_check',
      sql`${t.finishedAt} is null or ${t.finishedAt} >= ${t.startedAt}`,
    ),
    check('tool_calls_latency_check', sql`${t.latencyMs} is null or ${t.latencyMs} >= 0`),
    // Every send execution must be traceable to a human approval.
    check(
      'tool_calls_send_requires_approval_check',
      sql`${t.riskTier} <> 'send' or ${t.approvalId} is not null`,
    ),
    uniqueIndex('tool_calls_approval_uq').on(t.approvalId).where(sql`${t.approvalId} is not null`),
    index('tool_calls_run_idx').on(t.runId),
    index('tool_calls_running_started_idx').on(t.startedAt).where(sql`${t.status} = 'running'`),
  ],
)
