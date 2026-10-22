import { setTimeout as sleep } from 'node:timers/promises'
import { recoverStaleInFlightLlmCalls } from './audit/calls.js'
import { ConfigError, requireWorkerConfig, type WorkerConfig } from './config.js'
import { db, pool } from './db/index.js'
import { env } from './env.js'
import { errorMessage } from './errors.js'
import { handleDispatchJob } from './jobs/dispatch.js'
import { handleHeartbeatJob } from './jobs/heartbeat.js'
import { handleMailSyncCoordinatorJob, handleMailSyncJob } from './jobs/mail-sync.js'
import { handleMailTriageJob } from './jobs/mail-triage.js'
import { logger } from './logger.js'
import { createOpenAiMailClassifier } from './mail/openai-classifier.js'
import { recoverAbandonedTriage } from './mail/triage-state.js'
import { recoverStaleSending } from './notifications/outbox.js'
import type {
  HeartbeatJobData,
  MailSyncCoordinatorJobData,
  MailSyncJobData,
  MailTriageJobData,
} from './queue.js'
import { createBoss, ensureQueues, ensureSchedules, QUEUES, startBoss, stopBoss } from './queue.js'
import { createTelegramBot } from './telegram/bot.js'
import { createTelegramSender } from './telegram/sender.js'
import { acquireWorkerLock, type WorkerLock } from './worker-lock.js'

const log = logger.child({ process: 'worker' })

/** Bound for the pg-boss graceful stop inside the drain. */
const DRAIN_TIMEOUT_MS = 30_000
/** Hard ceiling for the whole drain; the process force-exits if it hangs. */
const FORCE_EXIT_AFTER_MS = DRAIN_TIMEOUT_MS + 5_000

let draining = false

function fatalLockLoss(reason: unknown): void {
  if (draining) {
    return // the drain releases the lock deliberately; 'end' on the client is expected
  }
  log.fatal(
    { err: errorMessage(reason) },
    'worker lock connection lost: the single-worker guarantee is gone',
  )
  process.exit(1)
}

async function main(): Promise<void> {
  // 1. Worker-only config (bot token, chat id, key ring, cron). One aggregated error, exit 1
  //    before any subsystem starts.
  let config: WorkerConfig
  try {
    config = requireWorkerConfig(env)
  } catch (error) {
    log.fatal(error instanceof ConfigError ? error.message : errorMessage(error))
    process.exit(1)
  }

  // 2. Single-worker advisory lock on a dedicated session — before pg-boss, recovery,
  //    schedules, or the bot. A second worker exits 1.
  let lock: WorkerLock | null = null
  try {
    lock = await acquireWorkerLock(env.DATABASE_URL)
  } catch (error) {
    log.fatal({ err: errorMessage(error) }, 'could not acquire the worker advisory lock')
    process.exit(1)
  }
  if (!lock) {
    log.fatal('another worker already holds the advisory lock; only one worker may run')
    process.exit(1)
  }
  lock.client.on('error', fatalLockLoss)
  lock.client.on('end', () => fatalLockLoss(new Error('worker lock connection ended')))

  // 3. pg-boss in its own schema, plus the two queues.
  const boss = createBoss(env.DATABASE_URL)
  boss.on('error', (error) => log.error({ err: errorMessage(error) }, 'pg-boss error'))
  await startBoss(boss)
  await ensureQueues(boss)

  // 4. Policy-aware startup recovery for rows left `sending` by a crash (SIGKILL is not
  //    drainable): at-most-once → quarantined, at-least-once → pending retry.
  const recovery = await recoverStaleSending(db)
  log.info(recovery, 'startup recovery complete')

  // Stale model-call reservations from a crash become unknown; budget keeps counting them.
  const staleLlmCalls = await recoverStaleInFlightLlmCalls(db)
  if (staleLlmCalls > 0) {
    log.warn({ staleLlmCalls }, 'stale model-call reservations recovered as unknown')
  }

  // The worker lock guarantees no peer is running, so any in-progress claim belongs to the
  // previous process and can be released immediately instead of waiting for the 45-minute sweep.
  const abandonedTriage = await recoverAbandonedTriage(db, { staleAfterMs: 0 })
  if (abandonedTriage > 0) {
    log.warn({ abandonedTriage }, 'abandoned classification claims recovered at startup')
  }

  // 5. Telegram sender + job workers.
  const sender = createTelegramSender(config.telegram)
  const shutdownController = new AbortController()
  let inFlightJobs = 0

  await boss.work<HeartbeatJobData>(
    QUEUES.heartbeat.name,
    { ...QUEUES.heartbeat.work },
    async (jobs) => {
      inFlightJobs += 1
      try {
        for (const job of jobs) {
          await handleHeartbeatJob({ jobId: job.id, data: job.data, log })
        }
      } finally {
        inFlightJobs -= 1
      }
    },
  )

  await boss.work(
    QUEUES.notificationDispatch.name,
    { ...QUEUES.notificationDispatch.work },
    async (jobs) => {
      inFlightJobs += 1
      try {
        for (const job of jobs) {
          await handleDispatchJob({ jobId: job.id, sender, signal: shutdownController.signal, log })
        }
      } finally {
        inFlightJobs -= 1
      }
    },
  )

  if (config.mail) {
    const mailConfig = config.mail
    const mailClassifier = createOpenAiMailClassifier(mailConfig)
    await boss.work<MailSyncCoordinatorJobData>(
      QUEUES.mailSyncCoordinator.name,
      { ...QUEUES.mailSyncCoordinator.work },
      async (jobs) => {
        inFlightJobs += 1
        try {
          for (const job of jobs) {
            await handleMailSyncCoordinatorJob({ jobId: job.id, data: job.data, boss, log })
          }
        } finally {
          inFlightJobs -= 1
        }
      },
    )

    await boss.work<MailSyncJobData>(
      QUEUES.mailSync.name,
      { ...QUEUES.mailSync.work },
      async (jobs) => {
        inFlightJobs += 1
        try {
          for (const job of jobs) {
            await handleMailSyncJob({
              jobId: job.id,
              data: job.data,
              mail: mailConfig,
              encryption: config.encryption,
              log,
            })
          }
        } finally {
          inFlightJobs -= 1
        }
      },
    )

    await boss.work<MailTriageJobData>(
      QUEUES.mailTriage.name,
      { ...QUEUES.mailTriage.work },
      async (jobs) => {
        inFlightJobs += 1
        try {
          for (const job of jobs) {
            await handleMailTriageJob({
              jobId: job.id,
              data: job.data,
              mail: mailConfig,
              classifier: mailClassifier,
              signal: shutdownController.signal,
              log,
            })
          }
        } finally {
          inFlightJobs -= 1
        }
      },
    )
  }

  // 6. Schedules: heartbeat from HEARTBEAT_CRON (UTC, missed: skip); dispatch every minute.
  //    The mail coordinator is scheduled only when mail processing is enabled.
  await ensureSchedules(boss, config.heartbeatCron, { mailEnabled: Boolean(config.mail) })

  // 7. Telegram bot (long polling) in the worker process — one poller, one chat. Startup
  //    failure is fatal: an unreachable/invalid bot must not silently skip inbound traffic.
  const bot = createTelegramBot({
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    log,
  })
  bot.start().catch((error) => {
    if (draining) {
      return // the drain stopped polling deliberately
    }
    log.fatal({ err: errorMessage(error) }, 'telegram bot stopped unexpectedly')
    process.exit(1)
  })

  log.info(
    {
      heartbeatCron: config.heartbeatCron,
      telegramChatId: config.telegram.chatId,
      mailEnabled: config.mail !== undefined,
    },
    'worker started',
  )

  // 7. Drain-on-shutdown (D026): stop new claims → let the in-flight send finish and
  //    finalize → stop pg-boss gracefully → release the lock → close pools → exit 0.
  const drain = async (signal: string): Promise<void> => {
    if (draining) {
      log.warn('second shutdown signal received; forcing exit')
      process.exit(1)
    }
    draining = true
    log.info({ signal, inFlightJobs }, 'shutdown requested; draining')

    const forceExit = setTimeout(() => {
      log.fatal('drain did not finish in time; forcing exit')
      process.exit(1)
    }, FORCE_EXIT_AFTER_MS)
    forceExit.unref()

    try {
      // Stop new dispatch claims; the in-flight send (bounded 15s) finishes and finalizes,
      // and the current tick completes inside the graceful stop below.
      shutdownController.abort()

      // Stop bot polling, then await in-flight bot handlers (small in-process counter).
      await bot.stop()
      while (bot.inFlightHandlers() > 0) {
        await sleep(25)
      }

      await stopBoss(boss)
      await lock.release()
      await pool.end()
      log.info('worker shut down cleanly')
      process.exit(0)
    } catch (error) {
      log.fatal({ err: errorMessage(error) }, 'error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGINT', () => void drain('SIGINT'))
  process.on('SIGTERM', () => void drain('SIGTERM'))
}

main().catch((error) => {
  log.fatal({ err: errorMessage(error) }, 'worker failed to start')
  process.exit(1)
})
