/**
 * Per-site, per-action daily submission caps (phase 05). The count uses
 * `browser_tasks(site, action, submitted_at)` over the configured local day, so every
 * submission attempt (verified or not) counts against the cap.
 */
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { browserTasks } from '../db/schema/index.js'
import { getBudgetSettings, localDayRange } from '../llm/budget.js'

export interface DailyCapCheck {
  allowed: boolean
  used: number
  cap: number
  dayKey: string
}

export async function checkDailyCap(
  db: Db,
  options: { site: string; action: string; cap: number; now?: Date },
): Promise<DailyCapCheck> {
  const now = options.now ?? new Date()
  const settings = await getBudgetSettings(db)
  const range = localDayRange(now, settings.timezone)

  const [row] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(browserTasks)
    .where(
      and(
        eq(browserTasks.site, options.site),
        eq(browserTasks.action, options.action),
        isNotNull(browserTasks.submittedAt),
        gte(browserTasks.submittedAt, range.start),
        lt(browserTasks.submittedAt, range.end),
      ),
    )

  const used = row?.used ?? 0
  return { allowed: used < options.cap, used, cap: options.cap, dayKey: range.dayKey }
}
