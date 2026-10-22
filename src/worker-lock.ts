import { Client, type Pool } from 'pg'

/**
 * Fixed two-int advisory key for the single-worker guarantee (D026). The namespace is an
 * arbitrary but stable constant; the id is trivial. Both fit int4.
 */
export const WORKER_LOCK_NAMESPACE = 0x6167656e
export const WORKER_LOCK_ID = 1

export interface WorkerLock {
  /** The dedicated connection holding the session lock. Errors/end on it are fatal. */
  readonly client: Client
  /** Unlocks (if still held) and ends the dedicated connection. */
  release(): Promise<void>
}

/**
 * Acquire the session-level advisory lock on a dedicated connection. The lock lives for the
 * connection's lifetime and is released automatically if the process or connection dies.
 *
 * Returns null when another session holds it (a second worker must exit 1, not retry).
 * Connection failures throw — treat them as fatal, not as "lock unavailable".
 */
export async function acquireWorkerLock(connectionString: string): Promise<WorkerLock | null> {
  const client = new Client({ connectionString })
  await client.connect()

  const result = await client.query<{ acquired: boolean }>(
    'select pg_try_advisory_lock($1, $2) as acquired',
    [WORKER_LOCK_NAMESPACE, WORKER_LOCK_ID],
  )
  if (result.rows[0]?.acquired !== true) {
    await client.end()
    return null
  }

  return { client, release: () => releaseWorkerLock(client) }
}

async function releaseWorkerLock(client: Client): Promise<void> {
  try {
    await client.query('select pg_advisory_unlock($1, $2)', [WORKER_LOCK_NAMESPACE, WORKER_LOCK_ID])
  } finally {
    await client.end()
  }
}

/**
 * Readiness probe for `/health/ready`: is the worker's advisory lock granted right now?
 * Matches the exact key pair (classid + objid). `objsubid` distinguishes key form (1 =
 * single-bigint, 2 = two-int), so it is deliberately not filtered here.
 */
export async function isWorkerLockHeld(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ held: boolean }>(
    `select exists (
      select 1 from pg_locks
      where locktype = 'advisory' and granted and classid = $1 and objid = $2
    ) as held`,
    [WORKER_LOCK_NAMESPACE, WORKER_LOCK_ID],
  )
  return result.rows[0]?.held === true
}
