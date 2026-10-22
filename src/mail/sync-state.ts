import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import type { AccountRow } from '../db/queries/accounts.js'
import { mailboxSyncState } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'

export type SyncStateRow = typeof mailboxSyncState.$inferSelect

export const SYNC_FAILURE_BASE_BACKOFF_MS = 60_000
export const SYNC_FAILURE_MAX_BACKOFF_MS = 60 * 60 * 1000
const SYNC_ERROR_LIMIT = 1_000

export function syncBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1)
  return Math.min(SYNC_FAILURE_MAX_BACKOFF_MS, SYNC_FAILURE_BASE_BACKOFF_MS * 2 ** exponent)
}

/**
 * Ensure one sync-state row exists. The first tracked connection boundary is the account's
 * creation time when the connect command has not already set one; it is never reset here.
 */
export async function ensureSyncState(
  db: Db,
  account: AccountRow,
  now: Date = new Date(),
): Promise<SyncStateRow> {
  const [existing] = await db
    .select()
    .from(mailboxSyncState)
    .where(eq(mailboxSyncState.accountId, account.id))
    .limit(1)
  if (existing) return existing

  const [created] = await db
    .insert(mailboxSyncState)
    .values({
      accountId: account.id,
      notificationBoundaryAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: mailboxSyncState.accountId })
    .returning()
  if (created) return created

  const [raced] = await db
    .select()
    .from(mailboxSyncState)
    .where(eq(mailboxSyncState.accountId, account.id))
    .limit(1)
  if (!raced) throw new Error(`sync state for account ${account.id} could not be created`)
  return raced
}

export async function markSyncPolled(
  db: Db,
  accountId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(mailboxSyncState)
    .set({ lastPolledAt: now, updatedAt: now })
    .where(eq(mailboxSyncState.accountId, accountId))
}

export interface SyncSuccessPatch {
  historyId?: string
  initialSyncCompletedAt?: Date
  needsFullResync?: boolean
}

export async function markSyncSuccess(
  db: Db,
  accountId: string,
  now: Date = new Date(),
  patch: SyncSuccessPatch = {},
): Promise<void> {
  await db
    .update(mailboxSyncState)
    .set({
      lastSuccessAt: now,
      lastError: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      updatedAt: now,
      ...(patch.historyId !== undefined ? { historyId: patch.historyId } : {}),
      ...(patch.initialSyncCompletedAt !== undefined
        ? { initialSyncCompletedAt: patch.initialSyncCompletedAt }
        : {}),
      ...(patch.needsFullResync !== undefined ? { needsFullResync: patch.needsFullResync } : {}),
    })
    .where(eq(mailboxSyncState.accountId, accountId))
}

export interface SyncFailureResult {
  consecutiveFailures: number
  backoffUntil: Date
  error: string
}

export async function markSyncFailure(
  db: Db,
  accountId: string,
  error: unknown,
  now: Date = new Date(),
): Promise<SyncFailureResult> {
  const [state] = await db
    .select({ consecutiveFailures: mailboxSyncState.consecutiveFailures })
    .from(mailboxSyncState)
    .where(eq(mailboxSyncState.accountId, accountId))
    .limit(1)
  const consecutiveFailures = (state?.consecutiveFailures ?? 0) + 1
  const backoffUntil = new Date(now.getTime() + syncBackoffMs(consecutiveFailures))
  const safeError = errorMessage(error, SYNC_ERROR_LIMIT)

  await db
    .update(mailboxSyncState)
    .set({
      lastFailureAt: now,
      lastError: safeError,
      consecutiveFailures,
      backoffUntil,
      updatedAt: now,
    })
    .where(eq(mailboxSyncState.accountId, accountId))

  return { consecutiveFailures, backoffUntil, error: safeError }
}

export async function setNeedsFullResync(
  db: Db,
  accountId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(mailboxSyncState)
    .set({ needsFullResync: true, updatedAt: now })
    .where(eq(mailboxSyncState.accountId, accountId))
}
