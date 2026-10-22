import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  LlmCallFailedError,
  LlmCallOutcomeUnknownError,
  recoverStaleInFlightLlmCalls,
  STALE_LLM_CALL_AFTER_MS,
  ToolCallError,
  withLlmCall,
  withToolCall,
} from '../src/audit/calls.js'
import { finishRun, RunNotStartedError, startRun, withRun } from '../src/audit/runs.js'
import { llmCalls, runs, toolCalls } from '../src/db/schema/index.js'
import { createApproval, createRun } from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

const BOSS_JOB_ID = '9d2f4f2e-8b1a-4c0e-9f5a-3f2a1b0c9d8e'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

async function onlyRun(): Promise<typeof runs.$inferSelect> {
  const rows = await db.select().from(runs)
  const [run] = rows
  if (rows.length !== 1 || !run) {
    throw new Error(`expected exactly one run row, got ${rows.length}`)
  }
  return run
}

describe('startRun / finishRun', () => {
  it('opens a running row with input, parent, and boss job id, then finalizes it', async () => {
    const parent = await startRun(db, { kind: 'mail_sync', trigger: 'schedule' })
    const run = await startRun(db, {
      kind: 'mail_triage',
      trigger: 'retry',
      input: { messageId: 'm-123', attempt: 1 },
      parentRunId: parent.id,
      bossJobId: BOSS_JOB_ID,
    })

    expect(run.status).toBe('running')
    expect(run.finishedAt).toBeNull()
    expect(run.parentRunId).toBe(parent.id)
    expect(run.bossJobId).toBe(BOSS_JOB_ID)
    expect(run.input).toEqual({ messageId: 'm-123', attempt: 1 })

    await finishRun(db, run.id, 'succeeded')
    const [finished] = await db.select().from(runs).where(eq(runs.id, run.id))
    expect(finished?.status).toBe('succeeded')
    expect(finished?.finishedAt).toBeInstanceOf(Date)
  })

  it('stores bounded error text on failure', async () => {
    const run = await startRun(db, { kind: 'system', trigger: 'manual' })
    await finishRun(db, run.id, 'failed', new Error('smtp exploded'))
    const [finished] = await db.select().from(runs).where(eq(runs.id, run.id))
    expect(finished?.status).toBe('failed')
    expect(finished?.error).toContain('smtp exploded')
  })
})

describe('withRun', () => {
  it('records success with finished_at and returns the handler result', async () => {
    const result = await withRun(
      { kind: 'system', trigger: 'schedule', bossJobId: BOSS_JOB_ID, input: { source: 'test' } },
      async ({ run }) => ({ runId: run.id, value: 42 }),
    )
    expect(result.value).toBe(42)

    const run = await onlyRun()
    expect(run.id).toBe(result.runId)
    expect(run.status).toBe('succeeded')
    expect(run.finishedAt).toBeInstanceOf(Date)
    expect(run.bossJobId).toBe(BOSS_JOB_ID)
    expect(run.error).toBeNull()
  })

  it('records failure with capped error text and rethrows so pg-boss can retry', async () => {
    await expect(
      withRun({ kind: 'notification_dispatch', trigger: 'schedule' }, async () => {
        throw new Error('dispatch exploded')
      }),
    ).rejects.toThrow('dispatch exploded')

    const run = await onlyRun()
    expect(run.status).toBe('failed')
    expect(run.finishedAt).toBeInstanceOf(Date)
    expect(run.error).toContain('dispatch exploded')
  })

  it('records cancelled when the shutdown signal aborted during the handler', async () => {
    const controller = new AbortController()

    await expect(
      withRun(
        { kind: 'notification_dispatch', trigger: 'schedule', signal: controller.signal },
        async () => {
          controller.abort()
          throw new Error('worker shutting down')
        },
      ),
    ).rejects.toThrow('worker shutting down')

    const run = await onlyRun()
    expect(run.status).toBe('cancelled')
    expect(run.finishedAt).toBeInstanceOf(Date)
    expect(run.error).toContain('worker shutting down')
  })

  it('refuses to start when the signal is already aborted and creates no run', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      withRun(
        { kind: 'notification_dispatch', trigger: 'schedule', signal: controller.signal },
        () => Promise.resolve('unused'),
      ),
    ).rejects.toBeInstanceOf(RunNotStartedError)

    expect(await db.select().from(runs)).toHaveLength(0)
  })
})

describe('withLlmCall', () => {
  it('records a success row with tokens, cost, latency, and provider request id', async () => {
    const run = await createRun()

    const result = await withLlmCall(
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'gpt-test',
        reasoningEffort: 'high',
        reservedCostUsd: 0.05,
      },
      () =>
        Promise.resolve({
          result: { category: 'urgent' },
          usage: {
            promptTokens: 1_200,
            cachedInputTokens: 300,
            completionTokens: 45,
            reasoningTokens: 12,
            costUsd: 0.0025,
            providerRequestId: 'req_test_1',
          },
        }),
    )
    expect(result).toEqual({ category: 'urgent' })

    const [call] = await db.select().from(llmCalls)
    expect(call).toMatchObject({
      runId: run.id,
      purpose: 'classify_email',
      model: 'gpt-test',
      status: 'succeeded',
      reasoningEffort: 'high',
      reservedCostUsd: '0.050000',
      promptTokens: 1_200,
      cachedInputTokens: 300,
      completionTokens: 45,
      reasoningTokens: 12,
      costUsd: '0.002500',
      providerRequestId: 'req_test_1',
      error: null,
    })
    expect(call?.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('records a failure row and rethrows', async () => {
    const run = await createRun()

    await expect(
      withLlmCall(
        {
          runId: run.id,
          purpose: 'classify_email',
          model: 'gpt-test',
          reservedCostUsd: 0.01,
        },
        () => Promise.reject(new Error('model unavailable')),
      ),
    ).rejects.toThrow('model unavailable')

    const [call] = await db.select().from(llmCalls)
    expect(call?.status).toBe('failed')
    expect(call?.error).toContain('model unavailable')
  })

  it('refuses a call without a positive budget reservation before contacting the model', async () => {
    const run = await createRun()
    let called = false

    await expect(
      withLlmCall(
        {
          runId: run.id,
          purpose: 'classify_email',
          model: 'gpt-test',
          reservedCostUsd: 0,
        },
        () => {
          called = true
          return Promise.resolve({ result: 'unused' })
        },
      ),
    ).rejects.toThrow(/positive reservedCostUsd/)

    expect(called).toBe(false)
    expect(await db.select().from(llmCalls)).toHaveLength(0)
  })

  it('records an unknown outcome and keeps the reserved cost', async () => {
    const run = await createRun()

    await expect(
      withLlmCall(
        {
          runId: run.id,
          purpose: 'classify_email',
          model: 'gpt-test',
          reasoningEffort: 'medium',
          reservedCostUsd: 0.04,
        },
        () =>
          Promise.reject(
            new LlmCallOutcomeUnknownError('timeout after request started', {
              usage: { costUsd: 0.01, providerRequestId: 'req_unknown' },
            }),
          ),
      ),
    ).rejects.toBeInstanceOf(LlmCallOutcomeUnknownError)

    const [call] = await db.select().from(llmCalls)
    expect(call).toMatchObject({
      status: 'unknown',
      reservedCostUsd: '0.040000',
      costUsd: '0.010000',
      reasoningEffort: 'medium',
      providerRequestId: 'req_unknown',
    })
    expect(call?.error).toContain('timeout after request started')
  })

  it('records a known failure with available usage and request id', async () => {
    const run = await createRun()

    await expect(
      withLlmCall(
        {
          runId: run.id,
          purpose: 'classify_email',
          model: 'gpt-test',
          reasoningEffort: 'medium',
          reservedCostUsd: 0.04,
        },
        () =>
          Promise.reject(
            new LlmCallFailedError('provider refused the request', {
              usage: {
                promptTokens: 500,
                cachedInputTokens: 100,
                cacheWriteTokens: 50,
                completionTokens: 20,
                reasoningTokens: 10,
                costUsd: 0.004,
                providerRequestId: 'req_failed',
              },
            }),
          ),
      ),
    ).rejects.toBeInstanceOf(LlmCallFailedError)

    const [call] = await db.select().from(llmCalls)
    expect(call).toMatchObject({
      status: 'failed',
      reservedCostUsd: '0.040000',
      promptTokens: 500,
      cachedInputTokens: 100,
      cacheWriteTokens: 50,
      completionTokens: 20,
      reasoningTokens: 10,
      costUsd: '0.004000',
      providerRequestId: 'req_failed',
      reasoningEffort: 'medium',
    })
    expect(call?.error).toContain('provider refused the request')
  })

  it('recovers only stale in-flight reservations as unknown', async () => {
    const run = await createRun()
    const staleAt = new Date(Date.now() - STALE_LLM_CALL_AFTER_MS - 1_000)
    await db.insert(llmCalls).values([
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'gpt-test',
        status: 'in_flight',
        reservedCostUsd: '0.030000',
        createdAt: staleAt,
      },
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'gpt-test',
        status: 'in_flight',
        reservedCostUsd: '0.020000',
      },
    ])

    expect(await recoverStaleInFlightLlmCalls(db)).toBe(1)

    const rows = await db.select().from(llmCalls)
    const stale = rows.find((row) => row.reservedCostUsd === '0.030000')
    const fresh = rows.find((row) => row.reservedCostUsd === '0.020000')
    expect(stale?.status).toBe('unknown')
    expect(stale?.reservedCostUsd).toBe('0.030000')
    expect(fresh?.status).toBe('in_flight')
  })
})

describe('withToolCall', () => {
  it('inserts a running row first and finalizes it with the result', async () => {
    const run = await createRun()

    const result = await withToolCall(
      { runId: run.id, toolName: 'search_email', riskTier: 'read', args: { queryId: 'q-1' } },
      (toolCallId) => Promise.resolve({ toolCallId, hits: 3 }),
    )
    expect(result.hits).toBe(3)

    const [call] = await db.select().from(toolCalls)
    expect(call).toMatchObject({
      runId: run.id,
      toolName: 'search_email',
      riskTier: 'read',
      status: 'succeeded',
      args: { queryId: 'q-1' },
      error: null,
      approvalId: null,
    })
    expect(call?.result).toEqual({ toolCallId: result.toolCallId, hits: 3 })
    expect(call?.finishedAt).toBeInstanceOf(Date)
    expect(call?.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('records the failure and rethrows', async () => {
    const run = await createRun()

    await expect(
      withToolCall({ runId: run.id, toolName: 'search_email', riskTier: 'read' }, () =>
        Promise.reject(new Error('tool crashed')),
      ),
    ).rejects.toThrow('tool crashed')

    const [call] = await db.select().from(toolCalls)
    expect(call?.status).toBe('failed')
    expect(call?.finishedAt).toBeInstanceOf(Date)
    expect(call?.error).toContain('tool crashed')
  })

  it('rejects send tier without an approval before any row exists', async () => {
    const run = await createRun()

    await expect(
      withToolCall({ runId: run.id, toolName: 'send_email', riskTier: 'send' }, () =>
        Promise.resolve('unused'),
      ),
    ).rejects.toBeInstanceOf(ToolCallError)

    expect(await db.select().from(toolCalls)).toHaveLength(0)
  })

  it('executes send tier with an approval, linked by approval_id', async () => {
    const run = await createRun()
    const approval = await createApproval(run.id, { toolName: 'send_email', riskTier: 'send' })

    await withToolCall(
      {
        runId: run.id,
        toolName: 'send_email',
        riskTier: 'send',
        approvalId: approval.id,
        args: { to: 'lead@example.test' },
      },
      () => Promise.resolve('sent'),
    )

    const [call] = await db.select().from(toolCalls)
    expect(call?.approvalId).toBe(approval.id)
    expect(call?.status).toBe('succeeded')

    // The unique partial index claims the approval: a second execution for the same approval
    // is rejected at the DB boundary.
    await expect(
      withToolCall(
        {
          runId: run.id,
          toolName: 'send_email',
          riskTier: 'send',
          approvalId: approval.id,
        },
        () => Promise.resolve('again'),
      ),
    ).rejects.toThrow()
  })
})

describe('withRun links audit detail', () => {
  it('groups llm and tool calls under the run opened by the wrapper', async () => {
    const runId = await withRun({ kind: 'mail_triage', trigger: 'schedule' }, async ({ run }) => {
      await withLlmCall(
        {
          runId: run.id,
          purpose: 'classify_email',
          model: 'gpt-test',
          reservedCostUsd: 0.01,
        },
        () => Promise.resolve({ result: 'ok' }),
      )
      await withToolCall({ runId: run.id, toolName: 'search_email', riskTier: 'read' }, () =>
        Promise.resolve('done'),
      )
      return run.id
    })

    const [run] = await db.select().from(runs).where(eq(runs.id, runId))
    expect(run?.status).toBe('succeeded')

    const [llm] = await db.select().from(llmCalls).where(eq(llmCalls.runId, runId))
    const [tool] = await db.select().from(toolCalls).where(eq(toolCalls.runId, runId))
    expect(llm?.runId).toBe(runId)
    expect(tool?.runId).toBe(runId)
  })
})
