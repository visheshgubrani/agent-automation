import { and, eq, lte, sql } from 'drizzle-orm'
import { fromDrizzle, type PgBoss } from 'pg-boss'
import {
  SCHEDULE_MISSED_AFTER_MS,
  scheduleCron,
  validateScheduleTemplate,
} from '../agent/schedules.js'
import { enqueueQueuedNotice } from '../agent/tasks.js'
import { withRun } from '../audit/runs.js'
import { type Db, db as defaultDb } from '../db/index.js'
import { browserSchedules, browserTasks } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import { type Logger, logger } from '../logger.js'
import { enqueueNotification } from '../notifications/outbox.js'
import { nudgeDispatch, QUEUES } from '../queue.js'

export async function handleBrowserSchedulesJob(options: {
  jobId: string
  boss: PgBoss
  db?: Db
  log?: Logger
  now?: Date
  signal?: AbortSignal
}) {
  const db = options.db ?? defaultDb
  const now = options.now ?? new Date()
  const log = options.log ?? logger
  const [due] = await db
    .select({ id: browserSchedules.id })
    .from(browserSchedules)
    .where(and(eq(browserSchedules.enabled, true), lte(browserSchedules.nextRunAt, now)))
    .limit(1)
  if (!due || options.signal?.aborted) return { runOpened: false, created: 0, skipped: 0 }
  return withRun(
    {
      db,
      log,
      kind: 'system',
      trigger: 'schedule',
      bossJobId: options.jobId,
      input: { job: 'browser-schedule-tick' },
      ...(options.signal ? { signal: options.signal } : {}),
    },
    async ({ run }) => {
      const counts = await db
        .transaction(async (tx) => {
          const schedules = await tx
            .select()
            .from(browserSchedules)
            .where(and(eq(browserSchedules.enabled, true), lte(browserSchedules.nextRunAt, now)))
            .orderBy(browserSchedules.nextRunAt)
            .limit(100)
            .for('update', { skipLocked: true })
          let created = 0
          let skipped = 0
          for (const schedule of schedules) {
            if (options.signal?.aborted) break
            let spec: ReturnType<typeof validateScheduleTemplate>
            let nextRunAt: Date
            let scheduledFor: Date
            try {
              spec = validateScheduleTemplate(schedule.site, schedule.action, schedule.specTemplate)
              nextRunAt = scheduleCron(schedule.cron, now).next().toDate()
              scheduledFor = scheduleCron(schedule.cron, new Date(now.getTime() + 1))
                .prev()
                .toDate()
              if (scheduledFor < schedule.nextRunAt) throw new Error('Invalid schedule cursor.')
            } catch {
              await tx
                .update(browserSchedules)
                .set({ enabled: false, updatedAt: now })
                .where(eq(browserSchedules.id, schedule.id))
              await enqueueNotification(tx, {
                kind: 'system',
                dedupeKey: `browser:schedule:${schedule.id}:invalid`,
                body: `Schedule ${schedule.id} was disabled because its configuration is invalid. Create a new schedule from Telegram.`,
                runId: run.id,
              })
              continue
            }
            const late = now.getTime() - scheduledFor.getTime() > SCHEDULE_MISSED_AFTER_MS
            if (late || scheduledFor > schedule.nextRunAt) {
              skipped++
              await enqueueNotification(tx, {
                kind: 'system',
                dedupeKey: `browser:schedule:${schedule.id}:skipped:${schedule.nextRunAt.toISOString()}`,
                body: `Schedule ${schedule.id}: missed occurrences more than 30 minutes late were skipped. Each future submission still needs approval.`,
                runId: run.id,
              })
            }
            if (!late) {
              const [task] = await tx
                .insert(browserTasks)
                .values({
                  source: 'schedule',
                  site: schedule.site,
                  action: schedule.action,
                  targetUrl: spec.targetUrl,
                  instruction: schedule.instruction,
                  spec,
                  scheduleId: schedule.id,
                  scheduledFor,
                })
                .onConflictDoNothing({
                  target: [browserTasks.scheduleId, browserTasks.scheduledFor],
                  where: sql`${browserTasks.scheduleId} is not null`,
                })
                .returning()
              if (task) {
                const jobId = await options.boss.send(
                  QUEUES.browserTask.name,
                  { taskId: task.id },
                  { db: fromDrizzle(tx, sql) },
                )
                if (!jobId) throw new Error('Could not enqueue the scheduled browser task.')
                await tx
                  .update(browserTasks)
                  .set({ bossJobId: jobId, updatedAt: now })
                  .where(eq(browserTasks.id, task.id))
                await enqueueQueuedNotice(tx, { task, runId: run.id })
                created++
              }
            }
            await tx
              .update(browserSchedules)
              .set({ nextRunAt, ...(!late ? { lastRunAt: scheduledFor } : {}), updatedAt: now })
              .where(eq(browserSchedules.id, schedule.id))
          }
          return { created, skipped }
        })
        .catch(() => {
          throw new Error('Browser schedule transaction failed; its cursor was not advanced.')
        })
      await nudgeDispatch(options.boss).catch((error: unknown) =>
        log.warn({ err: errorMessage(error) }, 'could not nudge schedule notifications'),
      )
      return { runOpened: true, ...counts }
    },
  )
}

/** A fetched job can be lost before claiming its task; queued rows remain the recovery anchor. */
export async function requeueBrowserTasks(db: Db, boss: PgBoss): Promise<number> {
  return db.transaction(async (tx) => {
    const queued = await tx
      .select({ id: browserTasks.id })
      .from(browserTasks)
      .where(
        and(
          eq(browserTasks.status, 'queued'),
          sql`coalesce(${browserTasks.statusReason}, '') not in ('confirmation_required', 'advice_required')`,
        ),
      )
      .for('update')
    for (const task of queued) {
      const jobId = await boss.send(
        QUEUES.browserTask.name,
        { taskId: task.id },
        { db: fromDrizzle(tx, sql) },
      )
      if (!jobId) throw new Error('Could not recover a queued browser task.')
      await tx
        .update(browserTasks)
        .set({ bossJobId: jobId, updatedAt: new Date() })
        .where(eq(browserTasks.id, task.id))
    }
    return queued.length
  })
}
