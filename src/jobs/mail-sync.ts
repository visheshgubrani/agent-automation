import type { PgBoss } from 'pg-boss'
import { withRun } from '../audit/runs.js'
import type { MailConfig } from '../config.js'
import type { KeyRing } from '../crypto/keys.js'
import { db, pool } from '../db/index.js'
import { errorMessage } from '../errors.js'
import { createAuthorizedGmailClient, GmailAuthError } from '../gmail/auth.js'
import { type Logger, logger } from '../logger.js'
import { listAccountsDueForSync } from '../mail/coordinator.js'
import { type GmailSyncApi, syncAccount } from '../mail/sync.js'
import { acquireAccountSyncLock } from '../mail/sync-lock.js'
import { markSyncFailure } from '../mail/sync-state.js'
import { countRunnableMessages, sweepTriageState } from '../mail/triage-state.js'
import {
  type MailSyncCoordinatorJobData,
  type MailSyncJobData,
  type MailTriageJobData,
  QUEUES,
} from '../queue.js'

export interface MailSyncCoordinatorContext {
  jobId: string
  data?: MailSyncCoordinatorJobData
  boss: PgBoss
  log?: Logger
}

export interface MailSyncCoordinatorResult {
  accounts: number
  enqueued: number
  skipped: number
  failed: number
  triage: { recovered: number; pending: number; runnable: number }
  triageJob: boolean
}

/**
 * Every-minute coordinator: enqueue one sync job per active, non-backing-off account and
 * sweep abandoned triage state. Per-account jobs do the network work and update cursors.
 * `singletonKey` only coalesces queue entries; correctness comes from the advisory lock and
 * transactional cursor, never from job deduplication.
 */
export async function handleMailSyncCoordinatorJob(
  context: MailSyncCoordinatorContext,
): Promise<MailSyncCoordinatorResult> {
  const log = context.log ?? logger
  return withRun(
    {
      kind: 'mail_sync',
      trigger: context.data?.source === 'manual' ? 'manual' : 'schedule',
      input: { job: 'coordinator' },
      bossJobId: context.jobId,
      log,
    },
    async ({ log: runLog }) => {
      const accounts = await listAccountsDueForSync(db)
      let enqueued = 0
      let skipped = 0
      let failed = 0

      for (const account of accounts) {
        try {
          const jobId = await context.boss.send(
            QUEUES.mailSync.name,
            { accountId: account.id, source: 'schedule' } satisfies MailSyncJobData,
            { singletonKey: account.id },
          )
          if (jobId) enqueued += 1
          else skipped += 1
        } catch (error) {
          failed += 1
          runLog.error(
            { accountId: account.id, err: errorMessage(error) },
            'failed to enqueue mail sync job',
          )
        }
      }

      const sweep = await sweepTriageState(db)
      const triage = { ...sweep, runnable: await countRunnableMessages(db) }

      let triageJob = false
      if (triage.runnable > 0) {
        const jobId = await context.boss.send(
          QUEUES.mailTriage.name,
          { source: 'schedule' } satisfies MailTriageJobData,
          { singletonKey: 'mail-triage' },
        )
        triageJob = jobId !== null
      }

      const result = {
        accounts: accounts.length,
        enqueued,
        skipped,
        failed,
        triage,
        triageJob,
      }
      runLog.info(result, 'mail sync coordinator complete')
      return result
    },
  )
}

export interface MailSyncJobContext {
  jobId: string
  data: MailSyncJobData
  mail: MailConfig
  encryption: KeyRing
  log?: Logger
}

export interface MailSyncJobResult {
  locked: boolean
  synced?: boolean
}

/**
 * Per-account job. The session advisory lock serializes sync for the account; a contended
 * account simply finishes without a run. All cursor/idempotency guarantees remain in the DB.
 */
export async function handleMailSyncJob(context: MailSyncJobContext): Promise<MailSyncJobResult> {
  const log = context.log ?? logger
  const accountId = context.data?.accountId
  if (!accountId) {
    throw new Error('mail sync job is missing accountId')
  }

  const lock = await acquireAccountSyncLock(pool, accountId)
  if (!lock) {
    log.info({ accountId }, 'mail sync already running for account; skipping')
    return { locked: false }
  }

  try {
    await withRun(
      {
        kind: 'mail_sync',
        trigger: context.data.source === 'manual' ? 'manual' : 'schedule',
        input: { accountId },
        bossJobId: context.jobId,
        log,
      },
      async ({ log: runLog }) => {
        try {
          const authorized = await createAuthorizedGmailClient({
            db,
            ring: context.encryption,
            gmail: context.mail.gmail,
            accountId,
          })
          await syncAccount({
            db,
            accountId,
            api: authorized.gmail as unknown as GmailSyncApi,
            requestDelayMs: context.mail.gmailRequestDelayMs,
            log: runLog,
          })
        } catch (error) {
          // Permanent auth failures already update account status; a transient auth failure
          // still needs the per-account backoff so the coordinator stops retrying immediately.
          if (error instanceof GmailAuthError && error.reason === 'transient') {
            await markSyncFailure(db, accountId, error)
          }
          throw error
        }
      },
    )
    return { locked: true, synced: true }
  } finally {
    await lock.release()
  }
}
