import { eq, sql } from 'drizzle-orm'
import type { KeyRing } from '../../crypto/keys.js'
import { normalizeEmailAddress } from '../../mail/normalize.js'
import type { Db, DbSession } from '../index.js'
import { type accountStatus, accounts, mailboxSyncState } from '../schema/index.js'
import { readCredential, upsertCredential } from './credentials.js'

export type AccountRow = typeof accounts.$inferSelect
export type AccountStatus = (typeof accountStatus.enumValues)[number]

export interface GmailConnectionInput {
  emailAddress: string
  grantedScopes: string[]
  accessToken: string
  accessTokenExpiresAt?: Date
  /** Present only when Google issued/rotated one; omitted means preserve the stored token. */
  refreshToken?: string
  displayName?: string | null
}

export interface GmailConnectionResult {
  account: AccountRow
  created: boolean
  /** True when this connection created the state row / first notification boundary. */
  boundarySet: boolean
  /** True when Google omitted a refresh token and the stored envelope was preserved. */
  refreshPreserved: boolean
}

export interface AccountSummary {
  id: string
  emailAddress: string
  displayName: string | null
  status: AccountStatus
  grantedScopes: string[]
  notificationBoundaryAt: Date | null
  lastPolledAt: Date | null
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  consecutiveFailures: number
  lastError: string | null
}

const REASON_LIMIT = 1000

function boundedReason(reason: string): string {
  return reason.trim().slice(0, REASON_LIMIT)
}

/** Find an account by case-insensitive address without exposing credential material. */
export async function findAccountByEmail(
  db: DbSession,
  emailAddress: string,
): Promise<AccountRow | undefined> {
  const normalized = normalizeEmailAddress(emailAddress)
  const [account] = await db
    .select()
    .from(accounts)
    .where(sql`lower(${accounts.emailAddress}) = ${normalized}`)
    .limit(1)
  return account
}

/**
 * Atomically persist a verified Gmail connection: account row, encrypted access/refresh
 * credentials, and the first-connection notification boundary. A reconnect preserves an
 * existing refresh token when Google omits one and never resets the boundary.
 */
export async function saveGmailConnection(
  db: Db,
  ring: KeyRing,
  input: GmailConnectionInput,
): Promise<GmailConnectionResult> {
  const emailAddress = normalizeEmailAddress(input.emailAddress)
  const accessToken = input.accessToken.trim()
  if (accessToken.length === 0) {
    throw new Error('Gmail connection requires a non-empty access token')
  }

  const grantedScopes = [...new Set(input.grantedScopes.map((scope) => scope.trim()))]
    .filter((scope) => scope.length > 0)
    .sort()
  if (grantedScopes.length === 0) {
    throw new Error('Gmail connection requires at least one granted scope')
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(accounts)
      .where(sql`lower(${accounts.emailAddress}) = ${emailAddress}`)
      .limit(1)

    if (!input.refreshToken) {
      const existingRefresh = existing
        ? await readCredential(tx, ring, existing.id, 'oauth_refresh_token')
        : null
      if (!existingRefresh) {
        throw new Error(
          'Google did not return a refresh token and no stored refresh token exists; rerun the connect command and consent again',
        )
      }
    }

    const now = new Date()
    let account: AccountRow | undefined
    if (existing) {
      const [updated] = await tx
        .update(accounts)
        .set({
          emailAddress,
          grantedScopes,
          status: 'active',
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          updatedAt: now,
        })
        .where(eq(accounts.id, existing.id))
        .returning()
      account = updated
    } else {
      const [created] = await tx
        .insert(accounts)
        .values({
          provider: 'gmail',
          emailAddress,
          displayName: input.displayName ?? null,
          grantedScopes,
          status: 'active',
        })
        .returning()
      account = created
    }

    if (!account) {
      throw new Error('failed to persist the Gmail account row')
    }

    const [syncState] = await tx
      .select({ notificationBoundaryAt: mailboxSyncState.notificationBoundaryAt })
      .from(mailboxSyncState)
      .where(eq(mailboxSyncState.accountId, account.id))
      .limit(1)

    let boundarySet = false
    if (!syncState) {
      await tx.insert(mailboxSyncState).values({
        accountId: account.id,
        notificationBoundaryAt: now,
      })
      boundarySet = true
    } else if (syncState.notificationBoundaryAt === null) {
      await tx
        .update(mailboxSyncState)
        .set({ notificationBoundaryAt: now, lastError: null, updatedAt: now })
        .where(eq(mailboxSyncState.accountId, account.id))
      boundarySet = true
    } else {
      // Successful reconnect proves the auth path works; keep the original boundary and
      // clear the auth error surfaced by a previous revoked/error state.
      await tx
        .update(mailboxSyncState)
        .set({ lastError: null, updatedAt: now })
        .where(eq(mailboxSyncState.accountId, account.id))
    }

    await upsertCredential(tx, ring, {
      accountId: account.id,
      kind: 'oauth_access_token',
      plaintext: accessToken,
      ...(input.accessTokenExpiresAt !== undefined
        ? { expiresAt: input.accessTokenExpiresAt }
        : {}),
    })

    if (input.refreshToken) {
      await upsertCredential(tx, ring, {
        accountId: account.id,
        kind: 'oauth_refresh_token',
        plaintext: input.refreshToken,
      })
    }

    return {
      account,
      created: !existing,
      boundarySet,
      refreshPreserved: !input.refreshToken,
    }
  })
}

/** Account health for local list/pause/resume controls. No token material is selected. */
export async function listAccountSummaries(db: DbSession): Promise<AccountSummary[]> {
  return db
    .select({
      id: accounts.id,
      emailAddress: accounts.emailAddress,
      displayName: accounts.displayName,
      status: accounts.status,
      grantedScopes: accounts.grantedScopes,
      notificationBoundaryAt: mailboxSyncState.notificationBoundaryAt,
      lastPolledAt: mailboxSyncState.lastPolledAt,
      lastSuccessAt: mailboxSyncState.lastSuccessAt,
      lastFailureAt: mailboxSyncState.lastFailureAt,
      consecutiveFailures: sql<number>`coalesce(${mailboxSyncState.consecutiveFailures}, 0)::int`,
      lastError: mailboxSyncState.lastError,
    })
    .from(accounts)
    .leftJoin(mailboxSyncState, eq(mailboxSyncState.accountId, accounts.id))
    .orderBy(accounts.emailAddress)
}

export async function setAccountStatus(
  db: DbSession,
  accountId: string,
  status: AccountStatus,
): Promise<AccountRow> {
  const [account] = await db
    .update(accounts)
    .set({ status, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning()
  if (!account) {
    throw new Error(`account ${accountId} was not found`)
  }
  return account
}

/**
 * Record a permanent authorization failure visibly on the account and sync state. Transient
 * failures do not call this. The reason must already be safe for storage/logs (no tokens).
 */
export async function markAccountAuthFailure(
  db: Db,
  accountId: string,
  status: Extract<AccountStatus, 'revoked' | 'error'>,
  reason: string,
): Promise<void> {
  const now = new Date()
  const safeReason = boundedReason(reason)
  await db.transaction(async (tx) => {
    await tx.update(accounts).set({ status, updatedAt: now }).where(eq(accounts.id, accountId))
    await tx
      .insert(mailboxSyncState)
      .values({
        accountId,
        lastError: safeReason,
        lastFailureAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: mailboxSyncState.accountId,
        set: { lastError: safeReason, lastFailureAt: now, updatedAt: now },
      })
  })
}
