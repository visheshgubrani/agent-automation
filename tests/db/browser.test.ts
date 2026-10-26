import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { browserTasks, toolCalls, userSettings } from '../../src/db/schema/index.js'
import {
  createArtifact,
  createBrowserHandoff,
  createBrowserTask,
  createRun,
  createTelegramMessage,
  createUserSettings,
} from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

const finished = () => ({ finishedAt: new Date() })
const submitted = () => ({ finishedAt: new Date(), submittedAt: new Date() })

describe('browser task status checks', () => {
  it('requires finished_at null exactly for open statuses', async () => {
    for (const status of ['queued', 'running', 'waiting_for_human'] as const) {
      await expect(createBrowserTask({ status, ...finished() })).rejects.toThrow()
    }
    await expect(createBrowserTask({ status: 'failed' })).rejects.toThrow()
    await expect(createBrowserTask({ status: 'cancelled' })).rejects.toThrow()

    const failed = await createBrowserTask({
      status: 'failed',
      statusReason: 'interrupted',
      ...finished(),
    })
    expect(failed.finishedAt).not.toBeNull()
    expect((await createBrowserTask()).status).toBe('queued')
  })

  it('requires submitted_at for succeeded, unverified, and outcome_unknown', async () => {
    for (const status of ['succeeded', 'unverified', 'outcome_unknown'] as const) {
      await expect(createBrowserTask({ status, ...finished() })).rejects.toThrow()
      const row = await createBrowserTask({ status, ...submitted() })
      expect(row.submittedAt).not.toBeNull()
    }
    // A failure after the click keeps its submission time.
    await createBrowserTask({ status: 'failed', ...submitted() })
  })

  it('bounds the instruction, URL, and status reason', async () => {
    await expect(createBrowserTask({ instruction: 'x'.repeat(4_001) })).rejects.toThrow()
    await expect(createBrowserTask({ targetUrl: '' })).rejects.toThrow()
    await expect(
      createBrowserTask({ status: 'failed', statusReason: '', ...finished() }),
    ).rejects.toThrow()
    await expect(
      createBrowserTask({ status: 'failed', statusReason: 'x'.repeat(65), ...finished() }),
    ).rejects.toThrow()
  })

  it('rejects a task that retries itself', async () => {
    const task = await createBrowserTask()
    await expect(
      db.update(browserTasks).set({ retryOfTaskId: task.id }).where(eq(browserTasks.id, task.id)),
    ).rejects.toThrow()
  })
})

describe('browser task uniqueness', () => {
  it('allows only one task to hold the browser', async () => {
    await createBrowserTask({ status: 'running' })
    for (const status of [
      'running',
      'waiting_for_human',
      'awaiting_approval',
      'executing',
    ] as const) {
      await expect(createBrowserTask({ status })).rejects.toThrow()
    }
    // Queued and finished tasks do not hold the slot.
    await createBrowserTask({ status: 'queued' })
    await createBrowserTask({ status: 'queued' })
    await createBrowserTask({ status: 'cancelled', ...finished() })
  })

  it('frees the slot when the active task finishes', async () => {
    const active = await createBrowserTask({ status: 'executing' })
    await db
      .update(browserTasks)
      .set({ status: 'outcome_unknown', ...submitted() })
      .where(eq(browserTasks.id, active.id))
    await createBrowserTask({ status: 'running' })
  })

  it('creates at most one task per request message', async () => {
    const message = await createTelegramMessage()
    await createBrowserTask({ requestMessageId: message.id })
    await expect(createBrowserTask({ requestMessageId: message.id })).rejects.toThrow()
    // Tasks without a request message (schedules, retries) are unconstrained.
    await createBrowserTask({ source: 'schedule' })
    await createBrowserTask({ source: 'schedule' })
  })
})

describe('browser handoffs', () => {
  it('allows one waiting handoff per task', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ runId: run.id, status: 'waiting_for_human' })
    await createBrowserHandoff(task.id, run.id)
    await expect(createBrowserHandoff(task.id, run.id)).rejects.toThrow()

    await createBrowserHandoff(task.id, run.id, { status: 'resolved', resolvedAt: new Date() })
    await createBrowserHandoff(task.id, run.id, { status: 'timed_out', resolvedAt: new Date() })
  })

  it('requires resolved_at exactly when not waiting, and expiry after request', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const task = await createBrowserTask({ runId: run.id, status: 'waiting_for_human' })
    await expect(
      createBrowserHandoff(task.id, run.id, { resolvedAt: new Date() }),
    ).rejects.toThrow()
    await expect(createBrowserHandoff(task.id, run.id, { status: 'resolved' })).rejects.toThrow()
    await expect(
      createBrowserHandoff(task.id, run.id, { expiresAt: new Date(Date.now() - 60_000) }),
    ).rejects.toThrow()
  })
})

describe('artifacts', () => {
  it('requires a lowercase hex sha256 and dedupes by kind and hash', async () => {
    await expect(createArtifact({ sha256: 'A'.repeat(64) })).rejects.toThrow()
    await expect(createArtifact({ sha256: 'abc' })).rejects.toThrow()
    await expect(createArtifact({ sha256: `${'0'.repeat(63)}g` })).rejects.toThrow()

    const sha256 = 'f'.repeat(64)
    await createArtifact({ sha256 })
    await expect(createArtifact({ sha256 })).rejects.toThrow()
  })

  it('requires a positive size and a relative storage path', async () => {
    await expect(createArtifact({ byteSize: 0 })).rejects.toThrow()
    await expect(createArtifact({ storagePath: '/etc/passwd' })).rejects.toThrow()
    await expect(createArtifact({ storagePath: '../outside.png' })).rejects.toThrow()
    await expect(createArtifact({ storagePath: 'ab/../../x.png' })).rejects.toThrow()
    await expect(createArtifact({ storagePath: '' })).rejects.toThrow()
    await createArtifact({ storagePath: 'ab/file..name.png' })
  })
})

describe('phase 05 enum values and settings', () => {
  it('accepts browser_task runs and unknown tool calls', async () => {
    const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const [call] = await db
      .insert(toolCalls)
      .values({
        runId: run.id,
        toolName: 'browser.snapshot',
        riskTier: 'read',
        status: 'unknown',
        startedAt: new Date(Date.now() - 1_000),
        finishedAt: new Date(),
      })
      .returning()
    expect(call?.status).toBe('unknown')
  })

  it('defaults the agent sub-limit to $0.50 and rejects negatives', async () => {
    const settings = await createUserSettings()
    expect(settings.agentDailyLimitUsd).toBe('0.50')
    await db.update(userSettings).set({ agentDailyLimitUsd: null }).where(eq(userSettings.id, 1))
    await expect(
      db.update(userSettings).set({ agentDailyLimitUsd: '-1' }).where(eq(userSettings.id, 1)),
    ).rejects.toThrow()
  })
})
