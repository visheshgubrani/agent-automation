import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  acquireWorkerLock,
  isWorkerLockHeld,
  WORKER_LOCK_ID,
  WORKER_LOCK_NAMESPACE,
  type WorkerLock,
} from '../src/worker-lock.js'
import { closeTestDb, pool } from './db/helpers.js'

const TEST_DATABASE_URL = process.env.DATABASE_URL
if (!TEST_DATABASE_URL) {
  throw new Error('DATABASE_URL is required for worker-lock tests')
}

afterAll(closeTestDb)

describe('worker advisory lock', () => {
  it('lets the first session acquire, blocks the second, and allows re-acquire after release', async () => {
    const first = await acquireWorkerLock(TEST_DATABASE_URL)
    if (!first) throw new Error('expected the first session to acquire the lock')

    const second = await acquireWorkerLock(TEST_DATABASE_URL)
    expect(second).toBeNull()

    await first.release()

    const third = await acquireWorkerLock(TEST_DATABASE_URL)
    if (!third) throw new Error('expected re-acquisition after release')
    await third.release()

    expect(await isWorkerLockHeld(pool)).toBe(false)
  })

  it('is visible to the readiness helper while held', async () => {
    expect(await isWorkerLockHeld(pool)).toBe(false)

    const lock = await acquireWorkerLock(TEST_DATABASE_URL)
    if (!lock) throw new Error('expected the lock to be acquired')
    expect(await isWorkerLockHeld(pool)).toBe(true)
    await lock.release()
    expect(await isWorkerLockHeld(pool)).toBe(false)
  })

  it('uses the documented two-int key', () => {
    expect(WORKER_LOCK_NAMESPACE).toBeGreaterThan(0)
    expect(WORKER_LOCK_NAMESPACE).toBeLessThan(2 ** 31)
    expect(WORKER_LOCK_ID).toBe(1)
  })

  it('ignores a matching lock held in another database', async () => {
    const databaseName = `worker_lock_${randomUUID().replaceAll('-', '')}_test`
    const otherDatabaseUrl = new URL(TEST_DATABASE_URL)
    otherDatabaseUrl.pathname = `/${databaseName}`

    await pool.query(`create database "${databaseName}"`)
    let otherLock: WorkerLock | null = null
    try {
      otherLock = await acquireWorkerLock(otherDatabaseUrl.toString())
      expect(otherLock).not.toBeNull()
      expect(await isWorkerLockHeld(pool)).toBe(false)

      const localLock = await acquireWorkerLock(TEST_DATABASE_URL)
      if (!localLock) throw new Error('expected this database to acquire its own worker lock')
      try {
        expect(await isWorkerLockHeld(pool)).toBe(true)
      } finally {
        await localLock.release()
      }
      expect(await isWorkerLockHeld(pool)).toBe(false)
    } finally {
      await otherLock?.release()
      await pool.query(`drop database "${databaseName}"`)
    }
  })
})
