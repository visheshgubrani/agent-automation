import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mailboxSyncState, messages } from '../../src/db/schema/index.js'
import {
  claimPendingMessages,
  countRunnableMessages,
  listPendingMessages,
  MAX_TRIAGE_ATTEMPTS,
  markTriagePermanentFailure,
  markTriageTransientFailure,
  releaseClaimedMessages,
  requeueFailedTriage,
  triageRetryDelayMs,
} from '../../src/mail/triage-state.js'
import { createAccount, createMessage } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

const NOW = new Date('2026-10-22T12:00:00Z')

async function accountWithBoundary(emailAddress: string, boundary: Date) {
  const account = await createAccount({ emailAddress })
  await db.insert(mailboxSyncState).values({
    accountId: account.id,
    notificationBoundaryAt: boundary,
  })
  return account
}

describe('fair classification claims', () => {
  it('prioritizes a live arrival over older silent backfill', async () => {
    const backfillAccount = await accountWithBoundary(
      'backfill@example.test',
      new Date('2026-10-22T00:00:00Z'),
    )
    const liveAccount = await accountWithBoundary(
      'live@example.test',
      new Date('2026-10-22T00:00:00Z'),
    )
    await createMessage(backfillAccount.id, {
      receivedAt: new Date('2026-10-21T12:00:00Z'),
    })
    const live = await createMessage(liveAccount.id, {
      receivedAt: new Date('2026-10-22T10:00:00Z'),
    })

    const claimed = await claimPendingMessages(db, { limit: 1, now: NOW })
    expect(claimed.map((row) => row.id)).toEqual([live.id])
  })

  it('interleaves accounts so one inbox cannot take a whole batch', async () => {
    const first = await accountWithBoundary('first@example.test', new Date('2026-10-22T00:00:00Z'))
    const second = await accountWithBoundary(
      'second@example.test',
      new Date('2026-10-22T00:00:00Z'),
    )
    for (let index = 0; index < 8; index += 1) {
      await createMessage(first.id, { receivedAt: new Date('2026-10-21T12:00:00Z') })
    }
    await createMessage(second.id, { receivedAt: new Date('2026-10-21T13:00:00Z') })

    const claimed = await claimPendingMessages(db, { limit: 2, now: NOW })
    expect(new Set(claimed.map((row) => row.accountId))).toEqual(new Set([first.id, second.id]))
  })

  it('excludes failed rows until their backoff elapses', async () => {
    const account = await createAccount()
    const backedOff = await createMessage(account.id, {
      triageStatus: 'failed',
      triageAttempts: 1,
      triageNextAttemptAt: new Date(NOW.getTime() + 5 * 60_000),
    })
    const pending = await createMessage(account.id)

    expect((await listPendingMessages(db, { now: NOW })).map((row) => row.id)).toEqual([pending.id])
    expect(await countRunnableMessages(db, { now: NOW })).toBe(1)

    const later = new Date(NOW.getTime() + 6 * 60_000)
    expect((await listPendingMessages(db, { now: later })).map((row) => row.id)).toEqual(
      expect.arrayContaining([pending.id, backedOff.id]),
    )
  })
})

describe('triage failure lifecycle', () => {
  it('schedules transient retries, terminates permanent failures, and requeues explicitly', async () => {
    const account = await createAccount()
    const message = await createMessage(account.id)
    const stuck = await createMessage(account.id, {
      triageStatus: 'pending',
      triageAttempts: MAX_TRIAGE_ATTEMPTS,
    })

    const [first] = await claimPendingMessages(db, { limit: 1, now: NOW })
    expect(first?.triageAttempts).toBe(1)

    await markTriageTransientFailure(db, {
      id: message.id,
      attempts: 1,
      error: new Error('rate limited'),
      now: NOW,
    })
    const [failed] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(failed?.triageStatus).toBe('failed')
    expect(failed?.triageNextAttemptAt?.toISOString()).toBe(
      new Date(NOW.getTime() + triageRetryDelayMs(1)).toISOString(),
    )
    expect(failed?.triageLastError).toContain('rate limited')

    expect(await claimPendingMessages(db, { limit: 1, now: NOW })).toHaveLength(0)

    const retryAt = new Date(NOW.getTime() + triageRetryDelayMs(1) + 1)
    const [retried] = await claimPendingMessages(db, { limit: 1, now: retryAt })
    expect(retried?.triageAttempts).toBe(2)

    await markTriagePermanentFailure(db, {
      id: message.id,
      error: new Error('model refused'),
      now: retryAt,
    })
    const [terminal] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(terminal?.triageStatus).toBe('failed')
    expect(terminal?.triageAttempts).toBe(MAX_TRIAGE_ATTEMPTS)
    expect(terminal?.triageNextAttemptAt).toBeNull()

    expect(await countRunnableMessages(db, { now: new Date('2027-01-01T00:00:00Z') })).toBe(0)
    expect(await requeueFailedTriage(db)).toBe(2)

    const [requeued] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(requeued).toMatchObject({
      triageStatus: 'pending',
      triageAttempts: 0,
      triageNextAttemptAt: null,
      triageLastError: null,
    })
    const [recoveredStuck] = await db.select().from(messages).where(eq(messages.id, stuck.id))
    expect(recoveredStuck).toMatchObject({ triageStatus: 'pending', triageAttempts: 0 })
  })

  it('releases unspent claims without consuming an attempt', async () => {
    const account = await createAccount()
    const message = await createMessage(account.id)

    await claimPendingMessages(db, { limit: 1, now: NOW })
    expect(await releaseClaimedMessages(db, [message.id], NOW)).toBe(1)

    const [released] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(released).toMatchObject({
      triageStatus: 'pending',
      triageAttempts: 0,
      triageNextAttemptAt: null,
    })
  })
})
