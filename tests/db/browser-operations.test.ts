import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { agentHeartbeatLine, getAgentStatus } from '../../src/agent/status.js'
import { createApp } from '../../src/app.js'
import {
  ARTIFACT_RETENTION_MS,
  loadArtifactPhoto,
  recordScreenshot,
  retainArtifacts,
} from '../../src/browser/artifacts.js'
import { artifacts, llmCalls } from '../../src/db/schema/index.js'
import { handleArtifactRetentionJob } from '../../src/jobs/artifact-retention.js'
import { handleHeartbeatJob } from '../../src/jobs/heartbeat.js'
import { createArtifact, createBrowserTask, createRun, createUserSettings } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const dirs: string[] = []
beforeEach(truncateAllTables)
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await closeTestDb()
})
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'retention-'))
  dirs.push(dir)
  return dir
}

describe('artifact retention', () => {
  it('deletes old files and tombstones rows; missing files tombstone too, fresh/boundary files survive', async () => {
    const dir = await directory()
    const now = new Date()
    const old = await recordScreenshot(db, { artifactDir: dir, bytes: new Uint8Array([1, 2, 3]) })
    const fresh = await recordScreenshot(db, { artifactDir: dir, bytes: new Uint8Array([4, 5, 6]) })
    const boundary = await recordScreenshot(db, {
      artifactDir: dir,
      bytes: new Uint8Array([7, 8, 9]),
    })
    await db
      .update(artifacts)
      .set({ createdAt: new Date(now.getTime() - ARTIFACT_RETENTION_MS - 1) })
      .where(eq(artifacts.id, old.id))
    await db
      .update(artifacts)
      .set({ createdAt: new Date(now.getTime() - ARTIFACT_RETENTION_MS) })
      .where(eq(artifacts.id, boundary.id))
    const missing = await createArtifact({
      createdAt: new Date(now.getTime() - ARTIFACT_RETENTION_MS - 1),
    })
    expect(await retainArtifacts(db, dir, now)).toEqual({ deleted: 2, failed: 0 })
    await expect(stat(join(dir, old.storagePath))).rejects.toThrow()
    expect(
      (await db.select().from(artifacts).where(eq(artifacts.id, old.id)))[0]?.deletedAt,
    ).toEqual(now)
    expect(
      (await db.select().from(artifacts).where(eq(artifacts.id, missing.id)))[0]?.deletedAt,
    ).toEqual(now)
    expect(
      await loadArtifactPhoto(db, dir, { artifactId: old.id, sha256: old.sha256 }),
    ).toBeUndefined()
    expect(
      await loadArtifactPhoto(db, dir, { artifactId: fresh.id, sha256: fresh.sha256 }),
    ).toEqual(new Uint8Array([4, 5, 6]))
    expect(await retainArtifacts(db, dir, now)).toEqual({ deleted: 0, failed: 0 })
    const revived = await recordScreenshot(db, {
      artifactDir: dir,
      bytes: new Uint8Array([1, 2, 3]),
    })
    expect(revived.id).toBe(old.id)
    expect(revived.deletedAt).toBeNull()
    expect(revived.createdAt.getTime()).toBeGreaterThan(now.getTime() - ARTIFACT_RETENTION_MS)
    expect(await readFile(join(dir, old.storagePath))).toEqual(Buffer.from([1, 2, 3]))
  })
  it('processes a backlog beyond one 500-row batch, and stops before deletion on shutdown', async () => {
    const dir = await directory()
    const now = new Date()
    const createdAt = new Date(now.getTime() - ARTIFACT_RETENTION_MS - 1)
    await db.insert(artifacts).values(
      Array.from({ length: 501 }, (_, i) => ({
        kind: 'screenshot' as const,
        sha256: (i + 100).toString(16).padStart(64, '0'),
        mime: 'image/png',
        byteSize: 1,
        storagePath: `missing-${i}.png`,
        createdAt,
      })),
    )
    const controller = new AbortController()
    controller.abort()
    expect(await retainArtifacts(db, dir, now, controller.signal)).toEqual({
      deleted: 0,
      failed: 0,
    })
    expect(await retainArtifacts(db, dir, now)).toEqual({ deleted: 501, failed: 0 })
  })
  it('serializes a concurrent store and retention by hash, leaving fresh bytes readable', async () => {
    const dir = await directory()
    const bytes = new Uint8Array([10, 11, 12])
    const row = await recordScreenshot(db, { artifactDir: dir, bytes })
    const now = new Date()
    await db
      .update(artifacts)
      .set({ createdAt: new Date(now.getTime() - ARTIFACT_RETENTION_MS - 1) })
      .where(eq(artifacts.id, row.id))
    await Promise.all([
      retainArtifacts(db, dir, now),
      recordScreenshot(db, { artifactDir: dir, bytes }),
    ])
    expect(await loadArtifactPhoto(db, dir, { artifactId: row.id, sha256: row.sha256 })).toEqual(
      bytes,
    )
  })
  it('leaves filesystem failures retryable and reports only counts in its job result', async () => {
    const dir = await directory()
    const now = new Date()
    const row = await createArtifact({
      storagePath: 'cannot-unlink-directory',
      createdAt: new Date(now.getTime() - ARTIFACT_RETENTION_MS - 1),
    })
    await mkdir(join(dir, row.storagePath))
    expect(
      await handleArtifactRetentionJob({
        db,
        artifactDir: dir,
        jobId: '11111111-2222-4333-8444-555555555555',
        now,
      }),
    ).toEqual({ deleted: 0, failed: 1 })
    expect((await db.select().from(artifacts))[0]?.deletedAt).toBeNull()
  })
})

describe('agent operational health', () => {
  it('counts task states and conservative agent/global spend, without any stored task/profile text or probe errors', async () => {
    const now = new Date()
    await createUserSettings({
      applicantProfile: 'PRIVATE-APPLICANT-PROFILE',
      agentDailyLimitUsd: '0.50',
    })
    await createBrowserTask({ instruction: 'PRIVATE-TASK-TEXT', status: 'queued' })
    await createBrowserTask({ status: 'awaiting_approval' })
    await createBrowserTask({ status: 'outcome_unknown', submittedAt: now, finishedAt: now })
    await createBrowserTask({ status: 'failed', statusReason: 'interrupted', finishedAt: now })
    const run = await createRun()
    await db.insert(llmCalls).values([
      {
        runId: run.id,
        purpose: 'agent_browser_step',
        model: 'gpt-6-luna',
        status: 'succeeded',
        costUsd: '0.020000',
        finishedAt: now,
      },
      {
        runId: run.id,
        purpose: 'agent_compose_text',
        model: 'gpt-6-luna',
        status: 'in_flight',
        reservedCostUsd: '0.100000',
      },
      {
        runId: run.id,
        purpose: 'agent_intake',
        model: 'gpt-6-luna',
        status: 'unknown',
        reservedCostUsd: '0.050000',
        finishedAt: now,
      },
      {
        runId: run.id,
        purpose: 'mail_classify',
        model: 'gpt-6-luna',
        status: 'succeeded',
        costUsd: '0.030000',
        finishedAt: now,
      },
    ])
    const status = await getAgentStatus(db, {
      now,
      enabled: true,
      probe: async () => {
        throw new Error('PRIVATE-PROBE-ERROR')
      },
    })
    expect(status.tasks).toMatchObject({
      queued: 1,
      awaitingApproval: 1,
      outcomeUnknown: 1,
      interrupted: 1,
    })
    expect(status.spend).toMatchObject({
      actualUsd: 0.02,
      reservedUsd: 0.15,
      totalUsd: 0.17,
      inFlight: 1,
      unknown: 1,
      globalTotalUsd: 0.2,
    })
    expect(status.browserReachable).toBe(false)
    const line = agentHeartbeatLine(status)
    expect(line).toContain('1 awaiting approval, 1 unknown, 1 interrupted')
    expect(line).toContain('$0.02 spent + $0.15 reserved')
    const heartbeat = await handleHeartbeatJob({
      db,
      jobId: '11111111-2222-4333-8444-555555555555',
    })
    expect(heartbeat.agent.tasks.outcomeUnknown).toBe(1)
    const response = await createApp().request('/health/details', {
      headers: { Authorization: `Bearer ${process.env.HEALTH_DETAILS_TOKEN}` },
    })
    const body = await response.json()
    expect(body.agent.tasks).toMatchObject({ outcomeUnknown: 1, interrupted: 1 })
    expect(JSON.stringify([status, body, line])).not.toContain('PRIVATE-')
  })
  it('does not probe the browser while disabled and keeps heartbeat idle output quiet', async () => {
    let calls = 0
    const status = await getAgentStatus(db, {
      enabled: false,
      probe: async () => {
        calls++
        return true
      },
    })
    expect(status.browserReachable).toBeNull()
    expect(calls).toBe(0)
    expect(agentHeartbeatLine(status)).toBeNull()
  })
})
