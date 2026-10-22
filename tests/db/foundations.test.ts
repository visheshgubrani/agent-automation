import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accountCredentials,
  accounts,
  interests,
  mailboxSyncState,
  userSettings,
  vipSenders,
  watchlistItems,
} from '../../src/db/schema/index.js'
import { createAccount } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('accounts, scopes, and resync state', () => {
  it('stores granted scopes and the default resync flag', async () => {
    const account = await createAccount({
      grantedScopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ],
    })
    expect(account.grantedScopes).toHaveLength(2)

    const [sync] = await db.insert(mailboxSyncState).values({ accountId: account.id }).returning()
    expect(sync?.needsFullResync).toBe(false)

    const [updated] = await db
      .update(mailboxSyncState)
      .set({ needsFullResync: true, historyId: 'history-123' })
      .where(eq(mailboxSyncState.accountId, account.id))
      .returning()
    expect(updated?.needsFullResync).toBe(true)
    expect(updated?.historyId).toBe('history-123')
  })

  it('rejects an invalid account status at the database boundary', async () => {
    await expect(
      db.insert(accounts).values({
        provider: 'gmail',
        emailAddress: 'invalid@example.test',
        status: 'unknown' as never,
      }),
    ).rejects.toThrow()
  })
})

describe('encrypted credentials', () => {
  const envelope = {
    ciphertext: Buffer.from('ciphertext-bytes'),
    nonce: Buffer.alloc(12, 1),
    authTag: Buffer.alloc(16, 2),
  }

  it('round-trips the bytea envelope and requires a key version', async () => {
    const account = await createAccount()
    const [credential] = await db
      .insert(accountCredentials)
      .values({
        accountId: account.id,
        kind: 'oauth_refresh_token',
        keyVersion: 1,
        ...envelope,
      })
      .returning()

    expect(credential?.ciphertext).toEqual(envelope.ciphertext)
    expect(credential?.nonce).toEqual(envelope.nonce)
    expect(credential?.authTag).toEqual(envelope.authTag)

    await expect(
      db.insert(accountCredentials).values({
        accountId: account.id,
        kind: 'oauth_access_token',
        keyVersion: 0,
        ...envelope,
      }),
    ).rejects.toThrow()
  })

  it('requires a 12-byte nonce and a 16-byte auth tag', async () => {
    const account = await createAccount()

    await expect(
      db.insert(accountCredentials).values({
        accountId: account.id,
        kind: 'oauth_refresh_token',
        keyVersion: 1,
        ciphertext: envelope.ciphertext,
        nonce: Buffer.alloc(4),
        authTag: envelope.authTag,
      }),
    ).rejects.toThrow()

    await expect(
      db.insert(accountCredentials).values({
        accountId: account.id,
        kind: 'oauth_refresh_token',
        keyVersion: 1,
        ciphertext: envelope.ciphertext,
        nonce: envelope.nonce,
        authTag: Buffer.alloc(8),
      }),
    ).rejects.toThrow()
  })

  it('allows only one credential of each kind per account', async () => {
    const account = await createAccount()
    await db
      .insert(accountCredentials)
      .values({ accountId: account.id, kind: 'oauth_refresh_token', keyVersion: 1, ...envelope })

    await expect(
      db
        .insert(accountCredentials)
        .values({ accountId: account.id, kind: 'oauth_refresh_token', keyVersion: 1, ...envelope }),
    ).rejects.toThrow()
  })
})

describe('preferences', () => {
  it('enforces a single settings row', async () => {
    await db.insert(userSettings).values({ id: 1 })
    await expect(db.insert(userSettings).values({ id: 2 })).rejects.toThrow()
  })

  it('requires quiet hours to be paired', async () => {
    await expect(
      db.insert(userSettings).values({ id: 1, quietHoursStart: '22:00:00' }),
    ).rejects.toThrow()

    const [settings] = await db
      .insert(userSettings)
      .values({
        id: 1,
        quietHoursStart: '22:00:00',
        quietHoursEnd: '07:00:00',
        quietHoursAllowUrgent: true,
      })
      .returning()
    expect(settings?.quietHoursStart).toBe('22:00:00')
  })

  it('rejects a non-positive batch window', async () => {
    await expect(db.insert(userSettings).values({ id: 1, batchWindowMinutes: 0 })).rejects.toThrow()
  })

  it('dedupes VIPs, watchlist values, and interests case-insensitively', async () => {
    await db.insert(vipSenders).values({ email: 'Boss@Example.test' })
    await expect(db.insert(vipSenders).values({ email: 'boss@example.test' })).rejects.toThrow()

    await db.insert(watchlistItems).values({ kind: 'ticker', value: 'AAPL' })
    await expect(
      db.insert(watchlistItems).values({ kind: 'ticker', value: 'aapl' }),
    ).rejects.toThrow()
    await db.insert(watchlistItems).values({ kind: 'company', value: 'aapl' })

    await db.insert(interests).values({ topic: 'Semiconductors' })
    await expect(db.insert(interests).values({ topic: 'semiconductors' })).rejects.toThrow()
  })
})
