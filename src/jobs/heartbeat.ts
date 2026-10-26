import { sql } from 'drizzle-orm'
import { type AgentHealthView, agentHeartbeatLine, getAgentStatus } from '../agent/status.js'
import { withRun } from '../audit/runs.js'
import { type Db, db as defaultDb } from '../db/index.js'
import { notificationOutbox } from '../db/schema/index.js'
import type { Logger } from '../logger.js'
import { getMailStatusSummary, mailHeartbeatLine } from '../mail/status.js'
import { enqueueNotification } from '../notifications/outbox.js'
import type { HeartbeatJobData } from '../queue.js'

export interface HeartbeatJobContext {
  /** pg-boss job id; also the dedupe key suffix, so a retried job inserts no second row. */
  jobId: string
  data?: HeartbeatJobData
  db?: Db
  log?: Logger
}

export interface HeartbeatResult {
  runId: string
  notificationId: string
  /** False when the dedupe key already existed (e.g. a retried job attempt). */
  inserted: boolean
  quarantined: number
  failed: number
  agent: AgentHealthView
  mail: {
    pending: number
    failed: number
    totalUsd: number
    dailyLimitUsd: number | null
  }
}

/**
 * The daily dead-man's switch (D024): count terminal quarantined/failed notifications, then
 * insert exactly one `system` outbox row (`at_most_once`, dedupe key
 * `system:heartbeat:<job id>`, run id attached). The dispatcher delivers it; silence means
 * the worker is down.
 */
export async function handleHeartbeatJob(context: HeartbeatJobContext): Promise<HeartbeatResult> {
  const db = context.db ?? defaultDb
  const source = context.data?.source ?? 'schedule'

  return withRun(
    {
      db,
      log: context.log,
      kind: 'system',
      trigger: source === 'manual' ? 'manual' : 'schedule',
      bossJobId: context.jobId,
      input: { job: 'heartbeat', source },
    },
    async ({ run }) => {
      const [counts] = await db
        .select({
          quarantined: sql<number>`count(*) filter (where ${notificationOutbox.status} = 'quarantined')::int`,
          failed: sql<number>`count(*) filter (where ${notificationOutbox.status} = 'failed')::int`,
        })
        .from(notificationOutbox)

      const quarantined = counts?.quarantined ?? 0
      const failed = counts?.failed ?? 0
      const [mail, agent] = await Promise.all([getMailStatusSummary(db), getAgentStatus(db)])
      const body = heartbeatBody(
        new Date(),
        quarantined,
        failed,
        mailHeartbeatLine(mail),
        agentHeartbeatLine(agent),
      )

      const { notification, inserted } = await enqueueNotification(db, {
        kind: 'system',
        dedupeKey: `system:heartbeat:${context.jobId}`,
        body,
        runId: run.id,
      })

      return {
        runId: run.id,
        notificationId: notification.id,
        inserted,
        quarantined,
        failed,
        agent,
        mail: {
          pending: mail.backlog.pending,
          failed: mail.backlog.failed,
          totalUsd: mail.spend.usage.totalUsd,
          dailyLimitUsd: mail.spend.settings.dailyLimitUsd,
        },
      }
    },
  )
}

/**
 * Plain-text heartbeat body: an ISO timestamp plus the uncertain/failed summary, but only
 * when non-zero ("N notifications had uncertain delivery", "M notifications failed"), and an
 * optional compact mail backlog/budget line.
 */
export function heartbeatBody(
  sentAt: Date,
  quarantined: number,
  failed: number,
  mailLine?: string | null,
  agentLine?: string | null,
): string {
  const lines = [`heartbeat ${sentAt.toISOString()} — worker is alive`]
  if (quarantined > 0) {
    lines.push(`${quarantined} notification${quarantined === 1 ? '' : 's'} had uncertain delivery`)
  }
  if (failed > 0) {
    lines.push(`${failed} notification${failed === 1 ? '' : 's'} failed`)
  }
  if (mailLine) {
    lines.push(mailLine)
  }
  if (agentLine) lines.push(agentLine)
  return lines.join('\n')
}
