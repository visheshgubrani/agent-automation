import { type ConstructorOptions, PgBoss, type QueuePolicy } from 'pg-boss'
import { errorMessage } from './errors.js'

/**
 * pg-boss owns this schema outright (D013): app code never models, migrates, or truncates
 * its tables. Orchestration lives here; idempotency comes from app-schema constraints.
 */
export const BOSS_SCHEMA = 'pgboss'

/** Every minute, UTC. Idle ticks open no run (see runDispatchTick). */
export const DISPATCH_CRON = '* * * * *'

/** Mail sync coordinator: approximately every minute, independently per active account. */
export const MAIL_SYNC_CRON = '* * * * *'

/** The dispatch nudge keeps new cards from waiting for the next minute tick (D045). */
export const DISPATCH_NUDGE_SINGLETON_KEY = 'nudge'
export const DISPATCH_NUDGE_SECONDS = 2

export interface QueueDefinition {
  name: string
  /**
   * Create-only queue fields (pg-boss `updateQueue` cannot change a policy). Passed only to
   * `createQueue`, so changing it needs a queue recreation.
   */
  policy?: QueuePolicy
  /** Created and worked only when `AGENT_ENABLED=true` (phase 05). */
  agent?: boolean
  create: { retryLimit: number; expireInSeconds: number }
  work: { batchSize: number; pollingIntervalSeconds: number }
}

export const QUEUES = {
  heartbeat: {
    name: 'heartbeat',
    create: { retryLimit: 2, expireInSeconds: 60 },
    work: { batchSize: 1, pollingIntervalSeconds: 2 },
  },
  notificationDispatch: {
    name: 'notification-dispatch',
    create: { retryLimit: 1, expireInSeconds: 300 },
    work: { batchSize: 1, pollingIntervalSeconds: 2 },
  },
  mailSyncCoordinator: {
    name: 'mail-sync-coordinator',
    create: { retryLimit: 1, expireInSeconds: 120 },
    work: { batchSize: 1, pollingIntervalSeconds: 2 },
  },
  mailSync: {
    name: 'mail-sync',
    // Backfills can exceed the dispatch/send bounds; pg-boss expiry is a safety net.
    create: { retryLimit: 2, expireInSeconds: 900 },
    work: { batchSize: 1, pollingIntervalSeconds: 2 },
  },
  mailTriage: {
    name: 'mail-triage',
    // Five calls at the 5-minute timeout ceiling stay inside this expiry safety net.
    create: { retryLimit: 2, expireInSeconds: 1_800 },
    work: { batchSize: 1, pollingIntervalSeconds: 2 },
  },
  agentIntake: {
    name: 'agent-intake',
    agent: true,
    create: { retryLimit: 1, expireInSeconds: 120 },
    work: { batchSize: 1, pollingIntervalSeconds: 2 },
  },
  browserScheduleTick: {
    name: 'browser-schedule-tick',
    agent: true,
    create: { retryLimit: 1, expireInSeconds: 60 },
    work: { batchSize: 1, pollingIntervalSeconds: 2 },
  },
  artifactRetention: {
    name: 'artifact-retention',
    agent: true,
    create: { retryLimit: 1, expireInSeconds: 300 },
    work: { batchSize: 1, pollingIntervalSeconds: 2 },
  },
  browserTask: {
    name: 'browser-task',
    agent: true,
    // One task holds the browser at a time; queued tasks wait for the active job to finish.
    policy: 'singleton',
    // Side effects are never auto-retried. The expiry is a safety net for a wedged job and
    // covers an approval page-hold.
    create: { retryLimit: 0, expireInSeconds: 7_200 },
    work: { batchSize: 1, pollingIntervalSeconds: 2 },
  },
} as const satisfies Record<string, QueueDefinition>

/** Payload carried by heartbeat jobs; the run trigger follows the source. */
export interface HeartbeatJobData {
  source?: 'schedule' | 'manual'
}

export interface MailSyncCoordinatorJobData {
  source?: 'schedule' | 'manual'
}

export interface MailSyncJobData {
  accountId: string
  source?: 'schedule' | 'manual'
}

export interface MailTriageJobData {
  source?: 'schedule' | 'manual'
}

/** Deterministic `/comment` intake: the stored inbound `telegram_messages` row. */
export interface AgentIntakeJobData {
  telegramMessageId: string
}

/** One browser task attempt; the task row is the idempotency anchor. */
export interface BrowserTaskJobData {
  taskId: string
}

/** Constructor options a caller may override; the schema and connection are always this app's. */
export type BossOptions = Omit<ConstructorOptions, 'connectionString' | 'schema'>

/**
 * Create an unstarted pg-boss client pinned to the `pgboss` schema. The worker uses the
 * defaults; short-lived tools (the heartbeat smoke script) disable scheduling/supervision so
 * they do not run cron work while merely enqueueing or observing jobs.
 */
export function createBoss(connectionString: string, options: BossOptions = {}): PgBoss {
  return new PgBoss({ connectionString, schema: BOSS_SCHEMA, ...options })
}

/** Connect and start maintenance/cron/polling subsystems. */
export async function startBoss(boss: PgBoss): Promise<void> {
  await boss.start()
}

/**
 * Graceful stop: in-flight work handlers run to completion, bounded by the timeout.
 * Callers abort their dispatch/bot signals first so handlers wind down promptly.
 */
export async function stopBoss(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: true, timeout: 30_000 })
}

/**
 * Create all queues idempotently and refresh their retry/expiry policy on every worker start.
 * Updating an existing queue keeps deployment config changes effective without deleting jobs.
 * Agent queues exist only when the agent is enabled, so the heartbeat-only path is unchanged.
 */
export async function ensureQueues(
  boss: PgBoss,
  options: { agentEnabled?: boolean } = {},
): Promise<void> {
  for (const value of Object.values(QUEUES)) {
    const queue: QueueDefinition = value
    if (queue.agent && !options.agentEnabled) {
      continue
    }
    await boss.createQueue(queue.name, {
      ...queue.create,
      ...(queue.policy !== undefined ? { policy: queue.policy } : {}),
    })
    // Policy is create-only; retry/expiry are safe to refresh on every start.
    await boss.updateQueue(queue.name, { ...queue.create })
  }
}

/**
 * Ask for an immediate dispatch pass. `singletonKey` plus a two-second window collapses
 * repeated nudges into one job, so a card that was just committed is sent within seconds
 * instead of on the next minute tick.
 */
export async function nudgeDispatch(boss: PgBoss): Promise<void> {
  await boss.send(
    QUEUES.notificationDispatch.name,
    {},
    {
      singletonKey: DISPATCH_NUDGE_SINGLETON_KEY,
      singletonSeconds: DISPATCH_NUDGE_SECONDS,
    },
  )
}

/**
 * Install cron schedules: heartbeat from `HEARTBEAT_CRON` (UTC, missed occurrences skipped),
 * the dispatch tick every minute, and the mail sync coordinator when mail is enabled. If mail
 * is disabled, remove any stale mail coordinator schedule so the heartbeat-only worker path does
 * not accumulate unprocessed jobs.
 */
export async function ensureSchedules(
  boss: PgBoss,
  heartbeatCron: string,
  options: { mailEnabled?: boolean; agentEnabled?: boolean } = {},
): Promise<void> {
  try {
    await boss.schedule(
      QUEUES.heartbeat.name,
      heartbeatCron,
      { source: 'schedule' } satisfies HeartbeatJobData,
      { tz: 'UTC', missed: 'skip' },
    )
    await boss.schedule(
      QUEUES.notificationDispatch.name,
      DISPATCH_CRON,
      {},
      { tz: 'UTC', missed: 'skip' },
    )
  } catch (error) {
    throw new Error(
      `invalid cron schedule (HEARTBEAT_CRON="${heartbeatCron}"): ${errorMessage(error)}`,
    )
  }

  if (options.mailEnabled) {
    await boss.schedule(
      QUEUES.mailSyncCoordinator.name,
      MAIL_SYNC_CRON,
      { source: 'schedule' } satisfies MailSyncCoordinatorJobData,
      { tz: 'UTC', missed: 'skip' },
    )
  } else {
    await boss.unschedule(QUEUES.mailSyncCoordinator.name)
  }
  if (options.agentEnabled) {
    await boss.schedule(
      QUEUES.browserScheduleTick.name,
      '* * * * *',
      {},
      { tz: 'UTC', missed: 'skip' },
    )
    await boss.schedule(
      QUEUES.artifactRetention.name,
      '0 3 * * *',
      {},
      { tz: 'Asia/Kolkata', missed: 'skip' },
    )
  } else {
    await boss.unschedule(QUEUES.browserScheduleTick.name)
    await boss.unschedule(QUEUES.artifactRetention.name)
  }
}
