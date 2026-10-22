import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { approvalResolver, approvalStatus, riskTier } from './enums.js'
import { runs } from './runs.js'

/**
 * A human approval request. payload is the exact execution contract and is never
 * regenerated or re-read from the model. Execution claims the approval through the unique
 * tool_calls.approval_id index; a failed send requires a new approval (linked by
 * retry_of_approval_id), never a reset of this one.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    toolName: text('tool_name').notNull(),
    riskTier: riskTier('risk_tier').notNull(),
    summary: text('summary').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    dedupeKey: text('dedupe_key'),
    retryOfApprovalId: uuid('retry_of_approval_id').references((): AnyPgColumn => approvals.id, {
      onDelete: 'set null',
    }),
    status: approvalStatus('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolver: approvalResolver('resolver'),
    resolverRef: text('resolver_ref'),
    resolutionNote: text('resolution_note'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('approvals_dedupe_key_uq').on(t.dedupeKey),
    check('approvals_expiry_check', sql`${t.expiresAt} > ${t.requestedAt}`),
    check(
      'approvals_pending_resolved_check',
      sql`(${t.status} = 'pending') = (${t.resolvedAt} is null)`,
    ),
    check(
      'approvals_pending_resolver_check',
      sql`(${t.status} = 'pending') = (${t.resolver} is null)`,
    ),
    check(
      'approvals_retry_not_self_check',
      sql`${t.retryOfApprovalId} is null or ${t.retryOfApprovalId} <> ${t.id}`,
    ),
    index('approvals_pending_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'pending'`),
    index('approvals_run_idx').on(t.runId),
    index('approvals_retry_of_idx')
      .on(t.retryOfApprovalId)
      .where(sql`${t.retryOfApprovalId} is not null`),
  ],
)
