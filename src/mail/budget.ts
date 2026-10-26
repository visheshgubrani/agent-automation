import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { getLlmBudgetUsageForRange, type LlmBudgetUsage } from '../db/queries/audit.js'
import { notificationOutbox } from '../db/schema/index.js'
import {
  DEFAULT_BUDGET_TIMEZONE,
  DEFAULT_DAILY_LIMIT_USD,
  getBudgetSettings,
  type LocalDayRange,
  localDayRange,
} from '../llm/budget.js'
import { enqueueNotification } from '../notifications/outbox.js'
import { estimateClassifierReservationUsd, getModelRates } from './pricing.js'

// Local-day ranges and settings moved to src/llm/ in phase 05; mail keeps its names.
export { type LocalDayRange, localDayRange } from '../llm/budget.js'
export const DEFAULT_MAIL_TIMEZONE = DEFAULT_BUDGET_TIMEZONE
export const DEFAULT_MAIL_DAILY_LIMIT_USD = DEFAULT_DAILY_LIMIT_USD

export interface MailBudgetSettings {
  timezone: string
  /** Null means no limit. */
  dailyLimitUsd: number | null
}

/** Settings fall back to the phase defaults when the singleton row is absent. */
export async function getMailBudgetSettings(db: Db): Promise<MailBudgetSettings> {
  const { timezone, dailyLimitUsd } = await getBudgetSettings(db)
  return { timezone, dailyLimitUsd }
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
