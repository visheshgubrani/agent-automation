import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { getLlmBudgetUsageForRange, type LlmBudgetUsage } from '../db/queries/audit.js'
import { notificationOutbox, userSettings } from '../db/schema/index.js'
import { enqueueNotification } from '../notifications/outbox.js'
import { estimateClassifierReservationUsd, getModelRates } from './pricing.js'

export const DEFAULT_MAIL_TIMEZONE = 'Asia/Kolkata'
export const DEFAULT_MAIL_DAILY_LIMIT_USD = 1

export interface MailBudgetSettings {
  timezone: string
  /** Null means no limit. */
  dailyLimitUsd: number | null
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

/** Settings fall back to the phase defaults when the singleton row is absent. */
export async function getMailBudgetSettings(db: Db): Promise<MailBudgetSettings> {
  const [row] = await db
    .select({
      timezone: userSettings.timezone,
      dailySpendLimitUsd: userSettings.dailySpendLimitUsd,
    })
    .from(userSettings)
    .where(eq(userSettings.id, 1))
    .limit(1)

  if (!row) {
    return { timezone: DEFAULT_MAIL_TIMEZONE, dailyLimitUsd: DEFAULT_MAIL_DAILY_LIMIT_USD }
  }

  return {
    timezone: row.timezone,
    dailyLimitUsd:
      row.dailySpendLimitUsd === null ? null : Math.max(0, Number(row.dailySpendLimitUsd)),
  }
}

export interface MailSpendStatus {
  settings: MailBudgetSettings
  range: LocalDayRange
  usage: LlmBudgetUsage
  /** Worst-case cost reserved for one classifier attempt. */
  reservationUsd: number
  /** True when one more reservation fits within the configured daily limit. */
  canAdmit: boolean
  /** Null when there is no configured limit. */
  remainingUsd: number | null
}

export interface MailSpendStatusOptions {
  now?: Date
  model: string
  maxInputChars: number
  maxOutputTokens: number
}

/**
 * Current local-day admission state. `usage.totalUsd` is the conservative budget query that
 * counts in-flight/unknown reservations as well as terminal actual cost.
 */
export async function getMailSpendStatus(
  db: Db,
  options: MailSpendStatusOptions,
): Promise<MailSpendStatus> {
  const settings = await getMailBudgetSettings(db)
  const range = localDayRange(options.now ?? new Date(), settings.timezone)
  const usage = await getLlmBudgetUsageForRange(db, range.start, range.end)
  const reservationUsd = estimateClassifierReservationUsd(getModelRates(options.model), {
    maxInputChars: options.maxInputChars,
    maxOutputTokens: options.maxOutputTokens,
  })

  const canAdmit =
    settings.dailyLimitUsd === null ||
    usage.totalUsd + reservationUsd <= settings.dailyLimitUsd + 1e-9

  return {
    settings,
    range,
    usage,
    reservationUsd,
    canAdmit,
    remainingUsd:
      settings.dailyLimitUsd === null ? null : Math.max(0, settings.dailyLimitUsd - usage.totalUsd),
  }
}

export interface BudgetNoticeResult {
  inserted: boolean
  notificationId?: string
}

/** Preflight uses this to open a short audit run only when the day's notice is still missing. */
export async function hasMailBudgetNotice(db: Db, dayKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.dedupeKey, `system:mail-budget:${dayKey}`))
    .limit(1)
  return row !== undefined
}

/**
 * One system notice per local day when classification pauses for budget. The dedupe key uses
 * the local day, so retries and every-minute sweeps cannot produce a notice burst.
 */
export async function enqueueMailBudgetNotice(
  db: Db,
  options: {
    status: MailSpendStatus
    pending: number
    runId?: string
  },
): Promise<BudgetNoticeResult> {
  const limit = options.status.settings.dailyLimitUsd
  if (limit === null) return { inserted: false }

  const { dayKey } = options.status.range
  const timezone = options.status.settings.timezone
  const body =
    `Mail classification is paused for ${dayKey} (${timezone}): the daily model budget of ` +
    `$${limit.toFixed(2)} is used up. ${options.pending} message(s) remain queued and will ` +
    'resume after local midnight. Mail sync and explicit rules continue.'

  const result = await enqueueNotification(db, {
    kind: 'system',
    dedupeKey: `system:mail-budget:${dayKey}`,
    body,
    payload: {
      dayKey,
      timezone,
      dailyLimitUsd: limit,
      usageUsd: options.status.usage.totalUsd,
      pending: options.pending,
    },
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  })

  return {
    inserted: result.inserted,
    notificationId: result.notification.id,
  }
}
