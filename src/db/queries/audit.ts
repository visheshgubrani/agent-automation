import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { Db } from '../index.js'
import { llmCalls } from '../schema/index.js'

/**
 * LLM spend for a half-open range [from, to). Callers compute local-day boundaries from
 * user_settings.timezone; costs are snapshotted per call, so this is historical spend.
 *
 * This sums recorded actual cost only. Budget admission must use
 * `getLlmBudgetUsageForRange`, which also counts in-flight/unknown reservations.
 */
export async function getLlmSpendForRange(
  db: Db,
  from: Date,
  to: Date,
): Promise<{ totalUsd: number; calls: number }> {
  const [row] = await db
    .select({
      totalUsd: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text`,
      calls: sql<number>`count(*)::int`,
    })
    .from(llmCalls)
    .where(and(gte(llmCalls.createdAt, from), lt(llmCalls.createdAt, to)))

  return { totalUsd: Number(row?.totalUsd ?? 0), calls: row?.calls ?? 0 }
}

export interface LlmBudgetUsage {
  /** Cost already recorded for terminal calls. */
  actualUsd: number
  /** Conservative worst-case cost held by in-flight or unknown attempts. */
  reservedUsd: number
  /** Admission total: actualUsd + reservedUsd. */
  totalUsd: number
  calls: number
  inFlight: number
  unknown: number
}

export interface LlmBudgetUsageOptions {
  /**
   * Count only calls whose `purpose` starts with this prefix (for example `agent_` for the
   * agent sub-limit, D044). Matched literally with `starts_with`, so `_` is not a wildcard.
   */
  purposePrefix?: string
}

/**
 * Daily budget usage for a half-open range [from, to). In-flight and unknown attempts count
 * their reserved worst-case cost (or actual cost if larger), so a crashed request cannot
 * silently free budget. Callers must pause while `totalUsd + nextReservation` exceeds the
 * configured daily limit. The range uses the `llm_calls(created_at)` index; the optional
 * purpose prefix filters within it.
 */
export async function getLlmBudgetUsageForRange(
  db: Db,
  from: Date,
  to: Date,
  options: LlmBudgetUsageOptions = {},
): Promise<LlmBudgetUsage> {
  const [row] = await db
    .select({
      actualUsd: sql<string>`coalesce(sum(
        case when ${llmCalls.status} in ('in_flight', 'unknown') then 0 else ${llmCalls.costUsd} end
      ), 0)::text`,
      reservedUsd: sql<string>`coalesce(sum(
        case when ${llmCalls.status} in ('in_flight', 'unknown')
          then greatest(${llmCalls.reservedCostUsd}, ${llmCalls.costUsd}) else 0 end
      ), 0)::text`,
      totalUsd: sql<string>`coalesce(sum(
        case when ${llmCalls.status} in ('in_flight', 'unknown')
          then greatest(${llmCalls.reservedCostUsd}, ${llmCalls.costUsd})
          else ${llmCalls.costUsd} end
      ), 0)::text`,
      calls: sql<number>`count(*)::int`,
      inFlight: sql<number>`(count(*) filter (where ${llmCalls.status} = 'in_flight'))::int`,
      unknown: sql<number>`(count(*) filter (where ${llmCalls.status} = 'unknown'))::int`,
    })
    .from(llmCalls)
    .where(
      and(
        gte(llmCalls.createdAt, from),
        lt(llmCalls.createdAt, to),
        options.purposePrefix !== undefined
          ? sql`starts_with(${llmCalls.purpose}, ${options.purposePrefix})`
          : undefined,
      ),
    )

  return {
    actualUsd: Number(row?.actualUsd ?? 0),
    reservedUsd: Number(row?.reservedUsd ?? 0),
    totalUsd: Number(row?.totalUsd ?? 0),
    calls: row?.calls ?? 0,
    inFlight: row?.inFlight ?? 0,
    unknown: row?.unknown ?? 0,
  }
}

/**
 * Model-call cost counted against one run (the per-task cap, D044), with the same conservative
 * accounting as the daily budget: in-flight/unknown rows count their reservation. Uses the
 * `llm_calls(run_id)` index.
 */
export async function getLlmBudgetUsageForRun(db: Db, runId: string): Promise<number> {
  const [row] = await db
    .select({
      totalUsd: sql<string>`coalesce(sum(
        case when ${llmCalls.status} in ('in_flight', 'unknown')
          then greatest(${llmCalls.reservedCostUsd}, ${llmCalls.costUsd})
          else ${llmCalls.costUsd} end
      ), 0)::text`,
    })
    .from(llmCalls)
    .where(eq(llmCalls.runId, runId))
  return Number(row?.totalUsd ?? 0)
}
