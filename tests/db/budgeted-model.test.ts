import { APICallError } from '@ai-sdk/provider'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { llmCalls } from '../../src/db/schema/index.js'
import { createBudgetedModel, ModelBudgetRefusedError } from '../../src/llm/budgeted-model.js'
import { withSerializedModelCall } from '../../src/mail/serial.js'
import { callParams, MISSING_USAGE, scriptedModel, textResult, usage } from '../fakes/model.js'
import { createRun, createUserSettings } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

async function setup(
  steps: Parameters<typeof scriptedModel>[0],
  overrides: { taskMaxUsd?: number; maxOutputTokens?: number } = {},
) {
  const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
  const mock = scriptedModel(steps)
  const model = createBudgetedModel(mock, {
    db,
    runId: run.id,
    purpose: 'agent_browser_step',
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    maxOutputTokens: overrides.maxOutputTokens ?? 1_000,
    taskMaxUsd: overrides.taskMaxUsd ?? 0.05,
  })
  return { run, mock, model }
}

const rows = (runId: string) => db.select().from(llmCalls).where(eq(llmCalls.runId, runId))

describe('budgeted agent model', () => {
  it('does not persist provider error messages that can echo private user text', async () => {
    const { run, model } = await setup([
      async () => {
        throw new APICallError({
          message: 'PRIVATE-REQUEST-TEXT',
          url: 'https://api.openai.com/v1/responses',
          requestBodyValues: { prompt: 'PRIVATE-REQUEST-TEXT' },
          statusCode: 400,
          responseHeaders: { 'x-request-id': 'req_safe' },
        })
      },
    ])
    await expect(model.doGenerate(callParams())).rejects.toThrow('agent model call rejected (400)')
    const [call] = await rows(run.id)
    expect(call).toMatchObject({ status: 'failed', providerRequestId: 'req_safe' })
    expect(call?.error).not.toContain('PRIVATE-REQUEST-TEXT')
  })

  it('counts a pinned intake run against the browser task cap, including unknown reservations', async () => {
    const intake = await createRun({ kind: 'agent_chat', trigger: 'telegram' })
    await db.insert(llmCalls).values({
      runId: intake.id,
      purpose: 'agent_intake',
      model: 'gpt-6-luna',
      status: 'unknown',
      reservedCostUsd: '0.050000',
    })
    const task = await createRun({ kind: 'browser_task', trigger: 'telegram' })
    const model = createBudgetedModel(scriptedModel([]), {
      db,
      runId: task.id,
      additionalRunIds: [intake.id, intake.id],
      purpose: 'agent_browser_step',
      model: 'gpt-6-luna',
      maxOutputTokens: 500,
      taskMaxUsd: 0.05,
    })
    await expect(model.doGenerate(callParams())).rejects.toMatchObject({ reason: 'task_cap' })
    expect(await rows(task.id)).toHaveLength(0)
    const [call] = await rows(intake.id)
    expect(call?.status).toBe('unknown')
  })

  it('reserves before the request and finalizes with actual usage', async () => {
    let seenDuringCall: (typeof llmCalls.$inferSelect)[] = []
    const { run, model } = await setup([
      async () => {
        seenDuringCall = await db.select().from(llmCalls)
        return textResult('ok', usage(1_000, 200, { cacheRead: 400, reasoning: 50 }))
      },
    ])

    const result = await model.doGenerate(callParams())
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])

    expect(seenDuringCall).toHaveLength(1)
    expect(seenDuringCall[0]?.status).toBe('in_flight')
    expect(Number(seenDuringCall[0]?.reservedCostUsd)).toBeGreaterThan(0)

    const [row] = await rows(run.id)
    expect(row?.status).toBe('succeeded')
    expect(row?.purpose).toBe('agent_browser_step')
    expect(row?.reasoningEffort).toBe('medium')
    expect(row?.promptTokens).toBe(1_000)
    expect(row?.cachedInputTokens).toBe(400)
    expect(row?.completionTokens).toBe(200)
    expect(row?.reasoningTokens).toBe(50)
    expect(row?.providerRequestId).toBe('resp_test')
    // 600 uncached * $0.10/M + 400 cached * $0.01/M + 200 output * $0.50/M
    expect(Number(row?.costUsd)).toBeCloseTo(0.000164, 6)
  })

  it('records the reservation as the cost when usage is missing', async () => {
    const { run, model } = await setup([textResult('ok', MISSING_USAGE)])
    await model.doGenerate(callParams())
    const [row] = await rows(run.id)
    expect(row?.status).toBe('succeeded')
    expect(Number(row?.costUsd)).toBe(Number(row?.reservedCostUsd))
  })

  it('records an abort or timeout as unknown and keeps the reservation', async () => {
    const { run, model } = await setup([
      async () => {
        throw new DOMException('The operation was aborted', 'AbortError')
      },
    ])
    await expect(model.doGenerate(callParams())).rejects.toThrow(/unknown|aborted/)
    const [row] = await rows(run.id)
    expect(row?.status).toBe('unknown')
    expect(Number(row?.reservedCostUsd)).toBeGreaterThan(0)

    const timeout = await setup([
      async () => {
        throw new DOMException('signal timed out', 'TimeoutError')
      },
    ])
    await expect(timeout.model.doGenerate(callParams())).rejects.toThrow()
    expect((await rows(timeout.run.id))[0]?.status).toBe('unknown')
  })

  it('records a definitive 4xx as failed with the request id, and a 5xx as unknown', async () => {
    const apiError = (statusCode: number) =>
      new APICallError({
        message: `status ${statusCode}`,
        url: 'https://api.openai.com/v1/responses',
        requestBodyValues: {},
        statusCode,
        responseHeaders: { 'x-request-id': `req_${statusCode}` },
      })
    const bad = await setup([
      async () => {
        throw apiError(400)
      },
    ])
    await expect(bad.model.doGenerate(callParams())).rejects.toThrow()
    const [failed] = await rows(bad.run.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.providerRequestId).toBe('req_400')

    const server = await setup([
      async () => {
        throw apiError(503)
      },
    ])
    await expect(server.model.doGenerate(callParams())).rejects.toThrow()
    expect((await rows(server.run.id))[0]?.status).toBe('unknown')
  })

  it('refuses at the task cap without a reservation or request', async () => {
    const { run, mock, model } = await setup([textResult('never')], { taskMaxUsd: 0.000001 })
    const error = await model.doGenerate(callParams()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelBudgetRefusedError)
    expect((error as ModelBudgetRefusedError).reason).toBe('task_cap')
    expect(mock.doGenerateCalls).toHaveLength(0)
    expect(await rows(run.id)).toHaveLength(0)
  })

  it('counts earlier calls in the same run toward the task cap', async () => {
    const { run, mock, model } = await setup(
      [textResult('one', MISSING_USAGE), textResult('two', MISSING_USAGE)],
      { taskMaxUsd: 0.0006 },
    )
    // One reservation (~ (2*chars + 1024) * $0.10/M + 500 * $0.50/M ≈ $0.00036) fits; two do not.
    await model.doGenerate(callParams())
    const error = await model.doGenerate(callParams()).catch((e: unknown) => e)
    expect((error as ModelBudgetRefusedError).reason).toBe('task_cap')
    expect(mock.doGenerateCalls).toHaveLength(1)
    expect(await rows(run.id)).toHaveLength(1)
  })

  it('refuses at the global daily limit and at the agent sub-limit', async () => {
    await createUserSettings({ dailySpendLimitUsd: '0.00', agentDailyLimitUsd: '0.50' })
    const daily = await setup([textResult('never')])
    const dailyError = await daily.model.doGenerate(callParams()).catch((e: unknown) => e)
    expect((dailyError as ModelBudgetRefusedError).reason).toBe('daily_limit')
    expect(daily.mock.doGenerateCalls).toHaveLength(0)

    await truncateAllTables()
    await createUserSettings({ dailySpendLimitUsd: '1.00', agentDailyLimitUsd: '0.00' })
    const agent = await setup([textResult('never')])
    const agentError = await agent.model.doGenerate(callParams()).catch((e: unknown) => e)
    expect((agentError as ModelBudgetRefusedError).reason).toBe('agent_limit')
    expect(agent.mock.doGenerateCalls).toHaveLength(0)
  })

  it('does not let mail spend count toward the agent sub-limit', async () => {
    await createUserSettings({ dailySpendLimitUsd: '1.00', agentDailyLimitUsd: '0.01' })
    const mailRun = await createRun()
    await db.insert(llmCalls).values({
      runId: mailRun.id,
      purpose: 'classify_email',
      model: 'gpt-6-luna',
      status: 'succeeded',
      costUsd: '0.500000',
    })
    const { model } = await setup([textResult('ok')])
    await expect(model.doGenerate(callParams())).resolves.toBeDefined()
  })

  it('requires a bounded maxOutputTokens and rejects streaming', async () => {
    const { mock, model } = await setup([textResult('never')], { maxOutputTokens: 1_000 })
    const missing = await model
      .doGenerate(callParams({ maxOutputTokens: undefined }))
      .catch((e: unknown) => e)
    expect((missing as ModelBudgetRefusedError).reason).toBe('max_output_tokens_required')
    const tooLarge = await model
      .doGenerate(callParams({ maxOutputTokens: 1_001 }))
      .catch((e: unknown) => e)
    expect((tooLarge as ModelBudgetRefusedError).reason).toBe('max_output_tokens_exceeded')
    const stream = await model.doStream(callParams()).catch((e: unknown) => e)
    expect((stream as ModelBudgetRefusedError).reason).toBe('streaming_not_supported')
    expect(mock.doGenerateCalls).toHaveLength(0)
    expect(mock.doStreamCalls).toHaveLength(0)
  })

  it('rejects non-text prompt parts', async () => {
    const { model } = await setup([textResult('never')])
    const error = await model
      .doGenerate(
        callParams({
          prompt: [
            {
              role: 'user',
              content: [{ type: 'file', mediaType: 'image/png', data: new Uint8Array([1]) }],
            },
          ],
        }),
      )
      .catch((e: unknown) => e)
    expect((error as ModelBudgetRefusedError).reason).toBe('non_text_prompt')
  })

  it('waits FIFO behind an in-flight mail classifier call', async () => {
    const order: string[] = []
    let releaseMail: () => void = () => undefined
    const mailGate = new Promise<void>((resolve) => {
      releaseMail = resolve
    })
    const mail = withSerializedModelCall(async () => {
      order.push('mail:start')
      await mailGate
      order.push('mail:end')
    })

    const { model } = await setup([
      async () => {
        order.push('agent:call')
        return textResult('ok')
      },
    ])
    const agent = model.doGenerate(callParams())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order).toEqual(['mail:start'])

    releaseMail()
    await Promise.all([mail, agent])
    expect(order).toEqual(['mail:start', 'mail:end', 'agent:call'])
  })

  it('requires an agent_ purpose', async () => {
    const run = await createRun()
    expect(() =>
      createBudgetedModel(scriptedModel([]), {
        db,
        runId: run.id,
        purpose: 'classify_email',
        model: 'gpt-6-luna',
        maxOutputTokens: 100,
        taskMaxUsd: 1,
      }),
    ).toThrow(/agent_/)
  })
})
