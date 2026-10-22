import { and, gte, lt, sql } from 'drizzle-orm'
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

/**
 * Daily budget usage for a half-open range [from, to). In-flight and unknown attempts count
 * their reserved worst-case cost (or actual cost if larger), so a crashed request cannot
 * silently free budget. Callers must pause while `totalUsd + nextReservation` exceeds the
 * configured daily limit.
 */
export async function getLlmBudgetUsageForRange(
  db: Db,
  from: Date,
  to: Date,
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
    .where(and(gte(llmCalls.createdAt, from), lt(llmCalls.createdAt, to)))

  return {
    actualUsd: Number(row?.actualUsd ?? 0),
    reservedUsd: Number(row?.reservedUsd ?? 0),
    totalUsd: Number(row?.totalUsd ?? 0),
    calls: row?.calls ?? 0,
    inFlight: row?.inFlight ?? 0,
    unknown: row?.unknown ?? 0,
  }
}
