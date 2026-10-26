import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { userSettings } from '../db/schema/index.js'

export const DEFAULT_BUDGET_TIMEZONE = 'Asia/Kolkata'
export const DEFAULT_DAILY_LIMIT_USD = 1
export const DEFAULT_AGENT_DAILY_LIMIT_USD = 0.5
/** Agent model-call purposes share this prefix; the agent sub-limit counts only them (D044). */
export const AGENT_PURPOSE_PREFIX = 'agent_'

export interface BudgetSettings {
  timezone: string
  /** Global daily limit across every purpose. Null means no limit. */
  dailyLimitUsd: number | null
  /** Agent sub-limit inside the global limit. Null means only the global limit applies. */
  agentDailyLimitUsd: number | null
}

export interface LocalDayRange {
  /** `YYYY-MM-DD` in the configured timezone; also the budget-notice dedupe key suffix. */
  dayKey: string
  start: Date
  end: Date
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)

  const values: Record<string, string> = {}
  for (const part of parts) values[part.type] = part.value
  const number = (type: string): number => Number(values[type])

  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour') % 24,
    minute: number('minute'),
    second: number('second'),
  }
}

function offsetMsAt(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const instant = Math.floor(date.getTime() / 1000) * 1000
  return asUtc - instant
}

function zonedDateTimeToUtc(
  parts: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  timeZone: string,
): Date {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day)
  const firstOffset = offsetMsAt(new Date(guess), timeZone)
  let instant = guess - firstOffset

  // A second pass handles a DST transition exactly at local midnight.
  const secondOffset = offsetMsAt(new Date(instant), timeZone)
  if (secondOffset !== firstOffset) {
    instant = guess - secondOffset
  }
  return new Date(instant)
}

function dayKey(parts: Pick<ZonedParts, 'year' | 'month' | 'day'>): string {
  const month = String(parts.month).padStart(2, '0')
  const day = String(parts.day).padStart(2, '0')
  return `${parts.year}-${month}-${day}`
}

/**
 * Half-open local-day range `[start, end)` in the configured IANA timezone. Budget admission
 * and the once-per-day notice use this range, not the worker's UTC day.
 */
export function localDayRange(now: Date, timeZone: string): LocalDayRange {
  const parts = zonedParts(now, timeZone)
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))

  return {
    dayKey: dayKey(parts),
    start: zonedDateTimeToUtc(parts, timeZone),
    end: zonedDateTimeToUtc(
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
      },
      timeZone,
    ),
  }
}

function limitOrNull(value: string | null): number | null {
  return value === null ? null : Math.max(0, Number(value))
}

/** Settings fall back to the phase defaults when the singleton row is absent. */
export async function getBudgetSettings(db: Db): Promise<BudgetSettings> {
  const [row] = await db
    .select({
      timezone: userSettings.timezone,
      dailySpendLimitUsd: userSettings.dailySpendLimitUsd,
      agentDailyLimitUsd: userSettings.agentDailyLimitUsd,
    })
    .from(userSettings)
    .where(eq(userSettings.id, 1))
    .limit(1)

  if (!row) {
    return {
      timezone: DEFAULT_BUDGET_TIMEZONE,
      dailyLimitUsd: DEFAULT_DAILY_LIMIT_USD,
      agentDailyLimitUsd: DEFAULT_AGENT_DAILY_LIMIT_USD,
    }
  }

  return {
    timezone: row.timezone,
    dailyLimitUsd: limitOrNull(row.dailySpendLimitUsd),
    agentDailyLimitUsd: limitOrNull(row.agentDailyLimitUsd),
  }
}
