import type { PgBoss } from 'pg-boss'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BOSS_SCHEMA,
  createBoss,
  DISPATCH_CRON,
  DISPATCH_NUDGE_SINGLETON_KEY,
  ensureQueues,
  ensureSchedules,
  MAIL_SYNC_CRON,
  nudgeDispatch,
  QUEUES,
  startBoss,
  stopBoss,
} from '../src/queue.js'
import { closeTestDb, pool } from './db/helpers.js'

const TEST_DATABASE_URL = process.env.DATABASE_URL
if (!TEST_DATABASE_URL) {
  throw new Error('DATABASE_URL is required for queue tests')
}

let boss: PgBoss

afterAll(async () => {
  if (boss) await stopBoss(boss)
  await closeTestDb()
})

describe('pg-boss runtime', () => {
  it('starts in its own pgboss schema and never touches public tables', async () => {
    boss = createBoss(TEST_DATABASE_URL)
    await startBoss(boss)

    const schema = await pool.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname = 'pgboss'",
    )
    expect(schema.rows).toHaveLength(1)

    const tables = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'pgboss'",
    )
    expect(tables.rows.length).toBeGreaterThan(0)
    expect(BOSS_SCHEMA).toBe('pgboss')
  })

  it('creates all queues with the documented retry/expire settings', async () => {
    await ensureQueues(boss)

    const heartbeat = await boss.getQueue(QUEUES.heartbeat.name)
    expect(heartbeat).not.toBeNull()
    expect(heartbeat?.retryLimit).toBe(2)
    expect(heartbeat?.expireInSeconds).toBe(60)

    const dispatch = await boss.getQueue(QUEUES.notificationDispatch.name)
    expect(dispatch).not.toBeNull()
    expect(dispatch?.retryLimit).toBe(1)
    expect(dispatch?.expireInSeconds).toBe(300)

    const coordinator = await boss.getQueue(QUEUES.mailSyncCoordinator.name)
    expect(coordinator).not.toBeNull()
    expect(coordinator?.retryLimit).toBe(1)
    expect(coordinator?.expireInSeconds).toBe(120)

    const sync = await boss.getQueue(QUEUES.mailSync.name)
    expect(sync).not.toBeNull()
    expect(sync?.retryLimit).toBe(2)
    expect(sync?.expireInSeconds).toBe(900)

    const triage = await boss.getQueue(QUEUES.mailTriage.name)
    expect(triage).not.toBeNull()
    expect(triage?.retryLimit).toBe(2)
    expect(triage?.expireInSeconds).toBe(1_800)
  })

  it('creates the agent queues with their create-only policy only when enabled', async () => {
    // The pgboss schema survives between test runs; start from a worker without agent queues.
    await boss.deleteQueue(QUEUES.agentIntake.name).catch(() => undefined)
    await boss.deleteQueue(QUEUES.browserTask.name).catch(() => undefined)
    await ensureQueues(boss, { agentEnabled: false })
    expect(await boss.getQueue(QUEUES.agentIntake.name)).toBeNull()
    expect(await boss.getQueue(QUEUES.browserTask.name)).toBeNull()

    await ensureQueues(boss, { agentEnabled: true })
    const intake = await boss.getQueue(QUEUES.agentIntake.name)
    expect(intake).not.toBeNull()
    expect(intake?.retryLimit).toBe(1)
    expect(intake?.expireInSeconds).toBe(120)
    expect(intake?.policy).toBe('standard')

    const browserTask = await boss.getQueue(QUEUES.browserTask.name)
    expect(browserTask).not.toBeNull()
    expect(browserTask?.policy).toBe('singleton')
    expect(browserTask?.retryLimit).toBe(0)
    expect(browserTask?.expireInSeconds).toBe(7_200)

    // The create-only policy of pre-existing queues stays at the pg-boss default.
    const dispatch = await boss.getQueue(QUEUES.notificationDispatch.name)
    expect(dispatch?.policy).toBe('standard')
  })

  it('collapses rapid dispatch nudges into one throttled job', async () => {
    await boss.deleteQueuedJobs(QUEUES.notificationDispatch.name)

    await nudgeDispatch(boss)
    await nudgeDispatch(boss)

    const jobs = await boss.findJobs(QUEUES.notificationDispatch.name, { queued: true })
    const nudges = jobs.filter(
      (job) => job.singletonKey === DISPATCH_NUDGE_SINGLETON_KEY && job.state === 'created',
    )
    expect(nudges).toHaveLength(1)
    await boss.deleteQueuedJobs(QUEUES.notificationDispatch.name)
  })

  it('installs the mail coordinator schedule only when mail is enabled', async () => {
    await ensureSchedules(boss, '0 9 * * *', { mailEnabled: true })
    let schedules = await boss.getSchedules()
    let byName = new Map(schedules.map((s) => [s.name, s]))
    expect(byName.get(QUEUES.mailSyncCoordinator.name)?.cron).toBe(MAIL_SYNC_CRON)

    await ensureSchedules(boss, '0 9 * * *', { mailEnabled: false })
    schedules = await boss.getSchedules()
    byName = new Map(schedules.map((s) => [s.name, s]))
    expect(byName.has(QUEUES.mailSyncCoordinator.name)).toBe(false)
  })

  it('installs the heartbeat and dispatch schedules', async () => {
    await ensureSchedules(boss, '0 9 * * *')

    const schedules = await boss.getSchedules()
    const byName = new Map(schedules.map((s) => [s.name, s]))
    expect(byName.get(QUEUES.heartbeat.name)?.cron).toBe('0 9 * * *')
    expect(byName.get(QUEUES.notificationDispatch.name)?.cron).toBe(DISPATCH_CRON)
  })

  it('sends and fetches jobs through the pgboss schema with uuid job ids', async () => {
    const sent = await boss.send(QUEUES.notificationDispatch.name, { source: 'test' })
    expect(sent).not.toBeNull()

    const [job] = await boss.fetch(QUEUES.notificationDispatch.name, { batchSize: 1 })
    if (!job) throw new Error('expected the sent job to be fetchable')
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/) // runs.boss_job_id is a uuid column
    expect(job.name).toBe(QUEUES.notificationDispatch.name)

    // Clean up the fetched job so nothing lingers in active state.
    await boss.deleteJob(QUEUES.notificationDispatch.name, job.id)
  })

  it('rejects an invalid heartbeat cron with a clear error', async () => {
    await expect(ensureSchedules(boss, 'not-a-cron')).rejects.toThrow(/HEARTBEAT_CRON/)
  })
})
