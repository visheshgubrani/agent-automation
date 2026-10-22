import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { approvals, toolCalls } from '../../src/db/schema/index.js'
import { createApproval, createRun } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

function resolvedApproval(runId: string, overrides = {}) {
  return createApproval(runId, {
    status: 'approved',
    resolvedAt: new Date(),
    resolver: 'telegram',
    resolverRef: '12345',
    ...overrides,
  })
}

describe('approval state', () => {
  it('requires resolved_at and resolver iff the approval is resolved', async () => {
    const run = await createRun()
    await expect(
      createApproval(run.id, { status: 'pending', resolvedAt: new Date() }),
    ).rejects.toThrow()
    await expect(
      createApproval(run.id, { status: 'pending', resolver: 'telegram' }),
    ).rejects.toThrow()

    const approved = await resolvedApproval(run.id)
    expect(approved.resolvedAt).not.toBeNull()
    expect(approved.resolver).toBe('telegram')
  })

  it('requires expiry after request and a unique dedupe key', async () => {
    const run = await createRun()
    await expect(
      createApproval(run.id, { expiresAt: new Date(Date.now() - 60_000) }),
    ).rejects.toThrow()

    await createApproval(run.id, { dedupeKey: 'approval-once' })
    await expect(createApproval(run.id, { dedupeKey: 'approval-once' })).rejects.toThrow()
  })

  it('records fresh-approval lineage for a failed send without reusing the old approval', async () => {
    const run = await createRun()
    const original = await resolvedApproval(run.id)
    await db.insert(toolCalls).values({
      runId: run.id,
      toolName: 'send_email',
      riskTier: 'send',
      status: 'failed',
      args: original.payload,
      error: 'smtp unavailable',
      approvalId: original.id,
      startedAt: new Date(Date.now() - 1_000),
      finishedAt: new Date(),
      latencyMs: 10,
    })

    const retry = await createApproval(run.id, {
      retryOfApprovalId: original.id,
      payload: original.payload,
    })
    expect(retry.status).toBe('pending')
    expect(retry.retryOfApprovalId).toBe(original.id)
    expect(retry.payload).toEqual(original.payload)
  })
})

describe('tool call execution claims', () => {
  it('rejects a send-tier tool call without an approval', async () => {
    const run = await createRun()
    await expect(
      db.insert(toolCalls).values({
        runId: run.id,
        toolName: 'send_email',
        riskTier: 'send',
        status: 'succeeded',
        startedAt: new Date(Date.now() - 1_000),
        finishedAt: new Date(),
      }),
    ).rejects.toThrow()
  })

  it('allows only one execution per approval', async () => {
    const run = await createRun()
    const approval = await resolvedApproval(run.id)

    const [execution] = await db
      .insert(toolCalls)
      .values({
        runId: run.id,
        toolName: 'send_email',
        riskTier: 'send',
        status: 'running',
        args: approval.payload,
        approvalId: approval.id,
        startedAt: new Date(Date.now() - 1_000),
      })
      .returning()
    expect(execution?.status).toBe('running')

    await expect(
      db.insert(toolCalls).values({
        runId: run.id,
        toolName: 'send_email',
        riskTier: 'send',
        status: 'succeeded',
        args: approval.payload,
        approvalId: approval.id,
        startedAt: new Date(),
        finishedAt: new Date(),
      }),
    ).rejects.toThrow()
  })

  it('enforces running/succeeded timestamp consistency', async () => {
    const run = await createRun()
    await expect(
      db.insert(toolCalls).values({
        runId: run.id,
        toolName: 'search_email',
        riskTier: 'read',
        status: 'running',
        finishedAt: new Date(),
      }),
    ).rejects.toThrow()

    await expect(
      db.insert(toolCalls).values({
        runId: run.id,
        toolName: 'search_email',
        riskTier: 'read',
        status: 'succeeded',
      }),
    ).rejects.toThrow()
  })

  it('keeps a failed execution terminal for its approval', async () => {
    const run = await createRun()
    const approval = await resolvedApproval(run.id)
    const [failed] = await db
      .insert(toolCalls)
      .values({
        runId: run.id,
        toolName: 'send_email',
        riskTier: 'send',
        status: 'failed',
        args: approval.payload,
        error: 'network refused before send',
        approvalId: approval.id,
        startedAt: new Date(Date.now() - 1_000),
        finishedAt: new Date(),
        latencyMs: 20,
      })
      .returning()

    await db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, approval.id))
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toContain('before send')
    // A retry is a new approval, never an update/reuse of this row (see D008).
    await expect(
      db.insert(toolCalls).values({
        runId: run.id,
        toolName: 'send_email',
        riskTier: 'send',
        status: 'succeeded',
        args: approval.payload,
        approvalId: approval.id,
        startedAt: new Date(),
        finishedAt: new Date(Date.now() + 1_000),
      }),
    ).rejects.toThrow()
  })
})
