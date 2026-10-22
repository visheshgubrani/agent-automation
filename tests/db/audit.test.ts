import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getLlmBudgetUsageForRange, getLlmSpendForRange } from '../../src/db/queries/audit.js'
import { llmCalls, runs, toolCalls } from '../../src/db/schema/index.js'
import { createApproval, createRun } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('LLM spend query', () => {
  it('sums snapshotted cost within a half-open range, including token detail columns', async () => {
    const run = await createRun()
    await db.insert(llmCalls).values([
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'test-model',
        status: 'succeeded',
        promptTokens: 1_000,
        cachedInputTokens: 400,
        completionTokens: 100,
        reasoningTokens: 25,
        costUsd: '0.001500',
        latencyMs: 120,
        createdAt: new Date('2026-01-15T10:00:00Z'),
      },
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'test-model',
        status: 'succeeded',
        costUsd: '0.002250',
        createdAt: new Date('2026-01-15T23:59:59Z'),
      },
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'test-model',
        status: 'failed',
        costUsd: '0.010000',
        error: 'rate limited',
        createdAt: new Date('2026-01-16T00:00:00Z'),
      },
    ])

    const spend = await getLlmSpendForRange(
      db,
      new Date('2026-01-15T00:00:00Z'),
      new Date('2026-01-16T00:00:00Z'),
    )
    expect(spend.calls).toBe(2)
    expect(spend.totalUsd).toBeCloseTo(0.00375, 6)
  })

  it('rejects negative token counts or costs', async () => {
    const run = await createRun()
    await expect(
      db.insert(llmCalls).values({
        runId: run.id,
        purpose: 'classify_email',
        model: 'test-model',
        status: 'succeeded',
        promptTokens: -1,
      }),
    ).rejects.toThrow()
  })

  it('counts in-flight and unknown reservations in budget usage, not actual spend', async () => {
    const run = await createRun()
    const at = new Date('2026-01-15T12:00:00Z')
    await db.insert(llmCalls).values([
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'test-model',
        status: 'succeeded',
        costUsd: '0.002500',
        reservedCostUsd: '0.050000',
        createdAt: at,
      },
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'test-model',
        status: 'in_flight',
        reservedCostUsd: '0.030000',
        createdAt: at,
      },
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'test-model',
        status: 'unknown',
        costUsd: '0.005000',
        reservedCostUsd: '0.020000',
        createdAt: at,
      },
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'test-model',
        status: 'failed',
        reservedCostUsd: '0.010000',
        createdAt: at,
      },
    ])

    const budget = await getLlmBudgetUsageForRange(
      db,
      new Date('2026-01-15T00:00:00Z'),
      new Date('2026-01-16T00:00:00Z'),
    )
    expect(budget.actualUsd).toBeCloseTo(0.0025, 6)
    expect(budget.reservedUsd).toBeCloseTo(0.05, 6)
    expect(budget.totalUsd).toBeCloseTo(0.0525, 6)
    expect(budget.calls).toBe(4)
    expect(budget.inFlight).toBe(1)
    expect(budget.unknown).toBe(1)

    const spend = await getLlmSpendForRange(
      db,
      new Date('2026-01-15T00:00:00Z'),
      new Date('2026-01-16T00:00:00Z'),
    )
    expect(spend.totalUsd).toBeCloseTo(0.0075, 6)
    expect(spend.calls).toBe(4)
  })
})

describe('runs and audit lifecycle', () => {
  it('requires finished_at for terminal run statuses', async () => {
    const run = await createRun()
    await expect(
      db.update(runs).set({ status: 'succeeded' }).where(eq(runs.id, run.id)),
    ).rejects.toThrow()

    const [finished] = await db
      .update(runs)
      .set({ status: 'succeeded', finishedAt: sql`now()` })
      .where(eq(runs.id, run.id))
      .returning()
    expect(finished?.status).toBe('succeeded')
  })

  it('groups LLM and tool calls under one run', async () => {
    const run = await createRun()
    await db.insert(llmCalls).values({
      runId: run.id,
      purpose: 'classify_email',
      model: 'test-model',
      status: 'succeeded',
      costUsd: '0.000100',
    })
    await db.insert(toolCalls).values({
      runId: run.id,
      toolName: 'search_email',
      riskTier: 'read',
      status: 'succeeded',
      startedAt: new Date(Date.now() - 1_000),
      finishedAt: new Date(),
      latencyMs: 5,
    })

    const [llmCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(llmCalls)
      .where(eq(llmCalls.runId, run.id))
    const [toolCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(toolCalls)
      .where(eq(toolCalls.runId, run.id))

    expect(llmCount?.count).toBe(1)
    expect(toolCount?.count).toBe(1)
  })

  it('cascades audit detail when a run is deliberately deleted', async () => {
    const run = await createRun()
    await db.insert(llmCalls).values({
      runId: run.id,
      purpose: 'classify_email',
      model: 'test-model',
      status: 'succeeded',
    })
    await db.insert(toolCalls).values({
      runId: run.id,
      toolName: 'search_email',
      riskTier: 'read',
      status: 'succeeded',
      startedAt: new Date(Date.now() - 1_000),
      finishedAt: new Date(),
    })

    await db.delete(runs).where(eq(runs.id, run.id))

    const llmRows = await db.select().from(llmCalls)
    const toolRows = await db.select().from(toolCalls)
    expect(llmRows).toHaveLength(0)
    expect(toolRows).toHaveLength(0)
  })

  it('blocks deleting a run that an approval still references', async () => {
    const run = await createRun()
    await createApproval(run.id)

    await expect(db.delete(runs).where(eq(runs.id, run.id))).rejects.toThrow()
  })
})
