import type { Pool } from 'pg'

/** Advisory-lock namespace for per-account mail sync; the worker lock uses a different key. */
export const MAIL_SYNC_LOCK_NAMESPACE = 0x6d61696c // "mail"

export interface AccountSyncLock {
  release(): Promise<void>
}

/**
 * Session advisory lock for one account, held on a dedicated pool connection. The lock is
 * released explicitly after the sync or automatically when the connection dies. A second
 * sync for the same account returns null instead of racing on the cursor.
 */
export async function acquireAccountSyncLock(
  pool: Pool,
  accountId: string,
): Promise<AccountSyncLock | null> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1, hashtext($2)) as locked',
      [MAIL_SYNC_LOCK_NAMESPACE, accountId],
    )
    if (!rows[0]?.locked) {
      client.release()
      return null
    }
  } catch (error) {
    client.release()
    throw error
  }

  let released = false
  return {
    async release(): Promise<void> {
      if (released) return
      released = true
      try {
        await client.query('select pg_advisory_unlock($1, hashtext($2))', [
          MAIL_SYNC_LOCK_NAMESPACE,
          accountId,
        ])
        client.release()
      } catch (error) {
        // Destroy the session so a failed unlock cannot leave the pool holding the lock.
        client.release(error as Error)
        throw error
      }
    },
  }
}
