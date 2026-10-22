import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { messages } from '../../src/db/schema/index.js'
import {
  claimPendingMessages,
  countPendingMessages,
  listPendingMessages,
  MAX_TRIAGE_ATTEMPTS,
  recoverAbandonedTriage,
  sweepTriageState,
} from '../../src/mail/triage-state.js'
import { createAccount, createMessage } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

async function message(overrides: Parameters<typeof createMessage>[1] = {}) {
  const account = await createAccount()
  return createMessage(account.id, overrides)
}

describe('pending triage sweep', () => {
  it('lists pending/failed work, respects attempts, and recovers only stale in-progress rows', async () => {
    const now = new Date('2026-10-21T00:00:00Z')
    const pending = await message({ triageStatus: 'pending' })
    const failed = await message({ triageStatus: 'failed', triageAttempts: 1 })
    const stale = await message({
      triageStatus: 'in_progress',
      triageAttempts: 1,
      updatedAt: new Date(now.getTime() - 5 * 60_000),
    })
    const fresh = await message({
      triageStatus: 'in_progress',
      triageAttempts: 1,
      updatedAt: now,
    })
    await message({ triageStatus: 'failed', triageAttempts: MAX_TRIAGE_ATTEMPTS })
    await message({ triageStatus: 'classified' })

    expect((await listPendingMessages(db)).map((row) => row.id)).toEqual(
      expect.arrayContaining([pending.id, failed.id]),
    )
    expect((await listPendingMessages(db)).some((row) => row.id === stale.id)).toBe(false)

    const recovered = await recoverAbandonedTriage(db, { now, staleAfterMs: 60_000 })
    expect(recovered).toBe(1)

    const [staleRow] = await db.select().from(messages).where(eq(messages.id, stale.id))
    const [freshRow] = await db.select().from(messages).where(eq(messages.id, fresh.id))
    expect(staleRow?.triageStatus).toBe('pending')
    expect(freshRow?.triageStatus).toBe('in_progress')

    expect((await listPendingMessages(db)).map((row) => row.id)).toEqual(
      expect.arrayContaining([pending.id, failed.id, stale.id]),
    )

    const claimed = await claimPendingMessages(db, { limit: 2, now })
    expect(claimed).toHaveLength(2)
    expect(claimed.every((row) => row.triageStatus === 'in_progress')).toBe(true)
    expect(claimed.every((row) => row.triageAttempts > 0)).toBe(true)
    expect(await countPendingMessages(db)).toBeGreaterThanOrEqual(4)
  })

  it('sweeps recovery and exposes pending counts', async () => {
    const now = new Date('2026-10-21T00:00:00Z')
    await message({ triageStatus: 'pending' })
    await message({
      triageStatus: 'in_progress',
      updatedAt: new Date(now.getTime() - 60 * 60_000),
    })

    const result = await sweepTriageState(db, { now })
    expect(result).toEqual({ recovered: 1, pending: 2 })
  })
})
