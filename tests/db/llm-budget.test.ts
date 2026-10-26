import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getLlmBudgetUsageForRange } from '../../src/db/queries/audit.js'
import { llmCalls } from '../../src/db/schema/index.js'
import {
  AGENT_PURPOSE_PREFIX,
  DEFAULT_AGENT_DAILY_LIMIT_USD,
  DEFAULT_BUDGET_TIMEZONE,
  DEFAULT_DAILY_LIMIT_USD,
  getBudgetSettings,
} from '../../src/llm/budget.js'
import { getMailBudgetSettings } from '../../src/mail/budget.js'
import { createRun, createUserSettings } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

const from = new Date('2026-01-15T00:00:00Z')
const to = new Date('2026-01-16T00:00:00Z')
const at = new Date('2026-01-15T12:00:00Z')

describe('budget usage by purpose prefix', () => {
  it('counts only agent purposes for the sub-limit, and everything for the global limit', async () => {
    const run = await createRun()
    await db.insert(llmCalls).values([
      {
        runId: run.id,
        purpose: 'classify_email',
        model: 'test-model',
        status: 'succeeded',
        costUsd: '0.100000',
        createdAt: at,
      },
      {
        runId: run.id,
        purpose: 'agent_browser_step',
        model: 'test-model',
        status: 'succeeded',
        costUsd: '0.020000',
        createdAt: at,
      },
      {
        runId: run.id,
        purpose: 'agent_intake',
        model: 'test-model',
        status: 'in_flight',
        reservedCostUsd: '0.030000',
        createdAt: at,
      },
      // `_` must not act as a LIKE wildcard: this is not an agent purpose.
      {
        runId: run.id,
        purpose: 'agentXstep',
        model: 'test-model',
        status: 'succeeded',
        costUsd: '0.400000',
        createdAt: at,
      },
    ])

    const agent = await getLlmBudgetUsageForRange(db, from, to, {
      purposePrefix: AGENT_PURPOSE_PREFIX,
    })
    expect(agent.calls).toBe(2)
    expect(agent.actualUsd).toBeCloseTo(0.02, 6)
    expect(agent.reservedUsd).toBeCloseTo(0.03, 6)
    expect(agent.totalUsd).toBeCloseTo(0.05, 6)
    expect(agent.inFlight).toBe(1)

    const global = await getLlmBudgetUsageForRange(db, from, to)
    expect(global.calls).toBe(4)
    expect(global.totalUsd).toBeCloseTo(0.55, 6)
  })
})

describe('budget settings', () => {
  it('falls back to the phase defaults without a settings row', async () => {
    expect(await getBudgetSettings(db)).toEqual({
      timezone: DEFAULT_BUDGET_TIMEZONE,
      dailyLimitUsd: DEFAULT_DAILY_LIMIT_USD,
      agentDailyLimitUsd: DEFAULT_AGENT_DAILY_LIMIT_USD,
    })
  })

  it('reads the agent sub-limit and keeps the mail view unchanged', async () => {
    await createUserSettings({ dailySpendLimitUsd: '2.00', agentDailyLimitUsd: '0.75' })
    expect(await getBudgetSettings(db)).toEqual({
      timezone: 'Asia/Kolkata',
      dailyLimitUsd: 2,
      agentDailyLimitUsd: 0.75,
    })
    expect(await getMailBudgetSettings(db)).toEqual({ timezone: 'Asia/Kolkata', dailyLimitUsd: 2 })
  })

  it('treats a null agent sub-limit as global-only', async () => {
    await createUserSettings({ agentDailyLimitUsd: null })
    expect((await getBudgetSettings(db)).agentDailyLimitUsd).toBeNull()
  })
})
