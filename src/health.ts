import { and, desc, eq, sql } from 'drizzle-orm'
import { type AgentHealthView, emptyAgentHealth, getAgentStatus } from './agent/status.js'
import { checkDb, type Db, db, pool } from './db/index.js'
import { runs } from './db/schema/index.js'
import { env } from './env.js'
import { getMailStatusSummary, type MailHealthView, mailHealthView } from './mail/status.js'
import { isWorkerLockHeld } from './worker-lock.js'

export type HealthProbe = () => Promise<boolean>

/** Public liveness: is the database reachable? */
export async function isDbUp(probe: HealthProbe = checkDb): Promise<boolean> {
  return probe()
}

/**
 * Public readiness: DB reachable **and** the worker's session advisory lock is held. A stopped
 * worker makes this 503 by design (readiness semantics, not an API outage).
 */
export async function isReady(probe: HealthProbe = checkDb): Promise<boolean> {
  const dbUp = await probe().catch(() => false)
  if (!dbUp) {
    return false
  }
  return isWorkerLockHeld(pool).catch(() => false)
}

export interface HealthDetails {
  db: boolean
  worker: {
    locked: boolean
    /** Latest `notification_dispatch` run's start time (ISO); idle ticks open no run. */
    lastDispatchAt: string | null
    /** Latest `system` (heartbeat) run's start time (ISO). */
    lastHeartbeatAt: string | null
    /** Latest `mail_sync` run's start time (ISO). */
    lastMailSyncAt: string | null
  }
  outbox: { due: number; sending: number; quarantined: number; failed: number }
  mail: MailHealthView
  agent: AgentHealthView
  telegramConfigured: boolean
  uptimeSeconds: number
  timestamp: string
}

async function latestRunStartedAt(
  db: Db,
  kind: 'notification_dispatch' | 'system' | 'mail_sync',
): Promise<string | null> {
  const [row] = await db
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(
      and(
        eq(runs.kind, kind),
        kind === 'system' ? sql`${runs.input}->>'job' = 'heartbeat'` : undefined,
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(1)
  return row?.startedAt.toISOString() ?? null
}

function emptyMailHealth(): MailHealthView {
  return {
    enabled: env.MAIL_ENABLED,
    accounts: { total: 0, active: 0, paused: 0, revoked: 0, error: 0, failing: 0 },
    backlog: { pending: 0, runnable: 0, failed: 0, exhausted: 0 },
    spend: {
      dayKey: '',
      timezone: 'Asia/Kolkata',
      actualUsd: 0,
      reservedUsd: 0,
      totalUsd: 0,
      dailyLimitUsd: null,
      remainingUsd: null,
      canAdmit: false,
      reservationUsd: 0,
    },
  }
}

/**
 * Detailed health for the token-protected route: DB state, worker lock, latest heartbeat and
 * dispatch runs, outbox delivery counts. Never touches pg-boss tables; never contains
 * secrets or message bodies.
 */
export async function healthDetails(probe: HealthProbe = checkDb): Promise<HealthDetails> {
  const dbUp = await probe().catch(() => false)
  if (!dbUp) {
    // Keep the failure minimal: nothing else is computable without the database.
    return {
      db: false,
      worker: {
        locked: false,
        lastDispatchAt: null,
        lastHeartbeatAt: null,
        lastMailSyncAt: null,
      },
      outbox: { due: 0, sending: 0, quarantined: 0, failed: 0 },
      mail: emptyMailHealth(),
      agent: emptyAgentHealth(),
      telegramConfigured: env.TELEGRAM_BOT_TOKEN !== undefined,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    }
  }

  const [locked, lastDispatchAt, lastHeartbeatAt, lastMailSyncAt, mail, agent] = await Promise.all([
    isWorkerLockHeld(pool).catch(() => false),
    latestRunStartedAt(db, 'notification_dispatch'),
    latestRunStartedAt(db, 'system'),
    latestRunStartedAt(db, 'mail_sync'),
    getMailStatusSummary(db),
    getAgentStatus(db),
  ])

  return {
    db: true,
    worker: { locked, lastDispatchAt, lastHeartbeatAt, lastMailSyncAt },
    outbox: mail.outbox,
    mail: mailHealthView(mail),
    agent,
    telegramConfigured: env.TELEGRAM_BOT_TOKEN !== undefined,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }
}
