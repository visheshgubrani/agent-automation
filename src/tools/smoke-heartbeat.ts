import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { eq } from 'drizzle-orm'
import type { Schedule } from 'pg-boss'
import { db, pool } from '../db/index.js'
import { notificationOutbox } from '../db/schema/index.js'
import { env } from '../env.js'
import { errorMessage } from '../errors.js'
import type { NotificationRow } from '../notifications/outbox.js'
import {
  createBoss,
  ensureQueues,
  type HeartbeatJobData,
  QUEUES,
  startBoss,
  stopBoss,
} from '../queue.js'

/** The smoke script waits this long for the worker to turn the job into a sent row. */
export const SMOKE_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 1_000

const TERMINAL_STATUSES = new Set<NotificationRow['status']>([
  'sent',
  'failed',
  'expired',
  'cancelled',
  'suppressed',
  'quarantined',
])

/**
 * End-to-end heartbeat smoke test: ensure the queues exist, enqueue one manual heartbeat job,
 * and poll the outbox by the job-derived dedupe key until the worker marks it `sent` (or a
 * terminal failure appears, or 90s elapse). Exits 0 only on `sent`.
 *
 * The worker must already be running; this script never starts a worker and never sends
 * Telegram itself. The daily heartbeat schedule stays untouched — the scheduled exit test is
 * a separate check that sets HEARTBEAT_CRON temporarily.
 *
 * Usage: `pnpm smoke:heartbeat` (worker running, real Telegram config in `.env`).
 */
async function main(): Promise<number> {
  const boss = createBoss(env.DATABASE_URL, { schedule: false, supervise: false })
  boss.on('error', (error) => console.error(`pg-boss error: ${errorMessage(error)}`))

  try {
    await startBoss(boss)
    await ensureQueues(boss)

    const jobId = await boss.send(QUEUES.heartbeat.name, {
      source: 'manual',
    } satisfies HeartbeatJobData)
    if (!jobId) {
      console.error('could not enqueue a heartbeat job (pg-boss returned no job id)')
      return 1
    }

    const dedupeKey = `system:heartbeat:${jobId}`
    console.log(`queued heartbeat job ${jobId}`)
    console.log(
      `waiting up to ${SMOKE_TIMEOUT_MS / 1000}s for outbox row ${dedupeKey} (is the worker running?)`,
    )

    const row = await waitForHeartbeatRow(dedupeKey)
    const schedule = await boss
      .getSchedule(QUEUES.heartbeat.name)
      .catch(() => null as Schedule | null)

    printResult(row, schedule)
    return row?.status === 'sent' ? 0 : 1
  } finally {
    await stopBoss(boss).catch((error) => {
      console.error(`could not stop pg-boss cleanly: ${errorMessage(error)}`)
    })
    await pool.end().catch((error) => {
      console.error(`could not close the database pool: ${errorMessage(error)}`)
    })
  }
}

/**
 * Poll the outbox for the job's dedupe key. Returns early on a terminal status; otherwise
 * waits out the full timeout (a pending row may still be retried by the worker).
 */
export async function waitForHeartbeatRow(
  dedupeKey: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<NotificationRow | undefined> {
  const timeoutMs = options.timeoutMs ?? SMOKE_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  let reportedStatus: NotificationRow['status'] | undefined

  while (Date.now() < deadline) {
    const row = await findRow(dedupeKey)
    if (row) {
      if (row.status !== reportedStatus) {
        console.log(`outbox status: ${row.status} (attempts ${row.attemptCount})`)
        reportedStatus = row.status
      }
      if (TERMINAL_STATUSES.has(row.status)) {
        return row
      }
    }
    await sleep(pollIntervalMs)
  }

  return findRow(dedupeKey)
}

async function findRow(dedupeKey: string): Promise<NotificationRow | undefined> {
  const [row] = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.dedupeKey, dedupeKey))
    .limit(1)
  return row
}

function printResult(row: NotificationRow | undefined, schedule: Schedule | null): void {
  if (schedule) {
    console.log(`heartbeat schedule: ${schedule.cron} (${schedule.timezone})`)
  } else {
    console.log(
      `heartbeat schedule: not installed (configured HEARTBEAT_CRON="${env.HEARTBEAT_CRON}")`,
    )
  }

  if (!row) {
    console.log('outbox status: not found (the worker did not process the job)')
    console.log('attempts: -')
    console.log('lastError: -')
    console.log('telegramMessageId: -')
    return
  }

  console.log(`outbox status: ${row.status}`)
  console.log(`attempts: ${row.attemptCount}`)
  console.log(`lastError: ${row.lastError ?? '(none)'}`)
  console.log(`telegramMessageId: ${row.telegramMessageId ?? '(none)'}`)
}

// Only run when executed as a script (`pnpm smoke:heartbeat`), not when imported by a test.
const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined
if (entrypoint === import.meta.url) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`heartbeat smoke failed: ${errorMessage(error)}`)
      process.exit(1)
    })
}
