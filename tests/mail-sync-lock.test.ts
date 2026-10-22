import { afterAll, describe, expect, it } from 'vitest'
import { acquireAccountSyncLock } from '../src/mail/sync-lock.js'
import { closeTestDb, pool } from './db/helpers.js'

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'

afterAll(closeTestDb)

describe('per-account sync lock', () => {
  it('serializes the same account and releases for the next sync', async () => {
    const first = await acquireAccountSyncLock(pool, ACCOUNT_ID)
    if (!first) throw new Error('expected the first lock')

    expect(await acquireAccountSyncLock(pool, ACCOUNT_ID)).toBeNull()
    await first.release()

    const third = await acquireAccountSyncLock(pool, ACCOUNT_ID)
    if (!third) throw new Error('expected the lock after release')
    await third.release()
  })

  it('does not block different accounts', async () => {
    const first = await acquireAccountSyncLock(pool, ACCOUNT_ID)
    const other = await acquireAccountSyncLock(pool, '22222222-2222-4222-8222-222222222222')
    try {
      expect(first).not.toBeNull()
      expect(other).not.toBeNull()
    } finally {
      await first?.release()
      await other?.release()
    }
  })
})
