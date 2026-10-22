import { sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { type AccountSummary, listAccountSummaries } from '../db/queries/accounts.js'
import { notificationOutbox } from '../db/schema/index.js'
import { DEFAULT_MAIL_MODEL, env } from '../env.js'
import { getMailSpendStatus, type MailSpendStatus } from './budget.js'
import { isSupportedMailModel } from './pricing.js'
import {
  countExhaustedTriage,
  countPendingMessages,
  countRunnableMessages,
  countTriageFailures,
} from './triage-state.js'

export interface MailBacklogCounts {
  pending: number
  runnable: number
  failed: number
  exhausted: number
}

export interface MailOutboxCounts {
  due: number
  sending: number
  failed: number
  quarantined: number
}

export interface MailStatusSummary {
  enabled: boolean
  accounts: AccountSummary[]
  backlog: MailBacklogCounts
  spend: MailSpendStatus
  outbox: MailOutboxCounts
}

export interface MailHealthView {
  enabled: boolean
  accounts: {
    total: number
    active: number
    paused: number
    revoked: number
    error: number
    failing: number
  }
  backlog: MailBacklogCounts
  spend: {
    dayKey: string
    timezone: string
    actualUsd: number
    reservedUsd: number
    totalUsd: number
    dailyLimitUsd: number | null
    remainingUsd: number | null
    canAdmit: boolean
    reservationUsd: number
  }
}

async function outboxCounts(db: Db): Promise<MailOutboxCounts> {
  const [row] = await db
    .select({
      due: sql<number>`count(*) filter (where ${notificationOutbox.status} in ('pending', 'batched'))::int`,
      sending: sql<number>`count(*) filter (where ${notificationOutbox.status} = 'sending')::int`,
      failed: sql<number>`count(*) filter (where ${notificationOutbox.status} = 'failed')::int`,
      quarantined: sql<number>`count(*) filter (where ${notificationOutbox.status} = 'quarantined')::int`,
    })
    .from(notificationOutbox)
  return {
    due: row?.due ?? 0,
    sending: row?.sending ?? 0,
    failed: row?.failed ?? 0,
    quarantined: row?.quarantined ?? 0,
  }
}

/**
 * One bounded status snapshot for `/mail status`, token-protected health details, and the daily
 * heartbeat. Account errors are already bounded by the sync/auth paths; no mail content or
 * secrets are included.
 */
export async function getMailStatusSummary(
  db: Db,
  options: { now?: Date } = {},
): Promise<MailStatusSummary> {
  const now = options.now ?? new Date()
  // The API can boot with an unsupported placeholder model while mail is disabled. Budget
  // visibility must still work, so estimate with the supported default in that case.
  const model = isSupportedMailModel(env.MAIL_MODEL) ? env.MAIL_MODEL : DEFAULT_MAIL_MODEL
  const [accounts, pending, runnable, failed, exhausted, spend, outbox] = await Promise.all([
    listAccountSummaries(db),
    countPendingMessages(db),
    countRunnableMessages(db, { now }),
    countTriageFailures(db),
    countExhaustedTriage(db),
    getMailSpendStatus(db, {
      now,
      model,
      maxInputChars: env.MAIL_MAX_INPUT_CHARS,
      maxOutputTokens: env.MAIL_MAX_OUTPUT_TOKENS,
    }),
    outboxCounts(db),
  ])

  return {
    enabled: env.MAIL_ENABLED,
    accounts,
    backlog: { pending, runnable, failed, exhausted },
    spend,
    outbox,
  }
}

/** Counts-only view for the token-protected health route; never includes account addresses. */
export function mailHealthView(summary: MailStatusSummary): MailHealthView {
  return {
    enabled: summary.enabled,
    accounts: {
      total: summary.accounts.length,
      active: summary.accounts.filter((account) => account.status === 'active').length,
      paused: summary.accounts.filter((account) => account.status === 'paused').length,
      revoked: summary.accounts.filter((account) => account.status === 'revoked').length,
      error: summary.accounts.filter((account) => account.status === 'error').length,
      failing: summary.accounts.filter((account) => account.consecutiveFailures > 0).length,
    },
    backlog: summary.backlog,
    spend: {
      dayKey: summary.spend.range.dayKey,
      timezone: summary.spend.settings.timezone,
      actualUsd: summary.spend.usage.actualUsd,
      reservedUsd: summary.spend.usage.reservedUsd,
      totalUsd: summary.spend.usage.totalUsd,
      dailyLimitUsd: summary.spend.settings.dailyLimitUsd,
      remainingUsd: summary.spend.remainingUsd,
      canAdmit: summary.spend.canAdmit,
      reservationUsd: summary.spend.reservationUsd,
    },
  }
}

/**
 * Compact heartbeat line. It stays silent in a heartbeat-only deployment with no mail state, but
 * surfaces backlog, failures, and the local-day budget once mail is enabled or has data.
 */
export function mailHeartbeatLine(summary: MailStatusSummary): string | null {
  const hasData =
    summary.enabled ||
    summary.accounts.length > 0 ||
    summary.backlog.pending > 0 ||
    summary.backlog.failed > 0 ||
    summary.spend.usage.totalUsd > 0
  if (!hasData) return null

  const limit = summary.spend.settings.dailyLimitUsd
  const spend =
    limit === null
      ? `$${summary.spend.usage.totalUsd.toFixed(2)} spent today`
      : `$${summary.spend.usage.totalUsd.toFixed(2)}/$${limit.toFixed(2)} today`
  const failingAccounts = summary.accounts.filter(
    (account) => account.consecutiveFailures > 0,
  ).length
  const accountNote =
    failingAccounts > 0
      ? `, ${failingAccounts} account${failingAccounts === 1 ? '' : 's'} failing`
      : ''
  const queued = Math.max(0, summary.backlog.pending - summary.backlog.failed)

  return `mail: ${queued} pending, ${summary.backlog.failed} failed, ${spend}${accountNote}`
}
