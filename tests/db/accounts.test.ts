import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { parseKeyRing } from '../../src/crypto/keys.js'
import {
  findAccountByEmail,
  listAccountSummaries,
  markAccountAuthFailure,
  saveGmailConnection,
} from '../../src/db/queries/accounts.js'
import { readCredential } from '../../src/db/queries/credentials.js'
import { accountCredentials, accounts, mailboxSyncState } from '../../src/db/schema/index.js'
import { GMAIL_READONLY_SCOPE } from '../../src/gmail/constants.js'
import { pauseMailAccount, resumeMailAccount } from '../../src/mail/accounts.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const ring = parseKeyRing(process.env.TOKEN_ENCRYPTION_KEYS ?? '', 1)
const OTHER_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

function connection(overrides: Record<string, unknown> = {}) {
  return {
    emailAddress: 'User@Example.test',
    grantedScopes: [GMAIL_READONLY_SCOPE],
    accessToken: 'access-token-1',
    accessTokenExpiresAt: new Date('2026-10-21T12:00:00Z'),
    refreshToken: 'refresh-token-1',
    ...overrides,
  }
}

describe('Gmail connection persistence', () => {
  it('atomically creates the account, encrypted credentials, and first-connection boundary', async () => {
    const result = await saveGmailConnection(db, ring, connection())

    expect(result.created).toBe(true)
    expect(result.boundarySet).toBe(true)
    expect(result.refreshPreserved).toBe(false)
    expect(result.account.emailAddress).toBe('user@example.test')
    expect(result.account.status).toBe('active')
    expect(result.account.grantedScopes).toEqual([GMAIL_READONLY_SCOPE])

    const [state] = await db.select().from(mailboxSyncState)
    expect(state?.notificationBoundaryAt).toBeInstanceOf(Date)
    expect(state?.lastError).toBeNull()

    expect(await readCredential(db, ring, result.account.id, 'oauth_access_token')).toBe(
      'access-token-1',
    )
    expect(await readCredential(db, ring, result.account.id, 'oauth_refresh_token')).toBe(
      'refresh-token-1',
    )

    const credentials = await db.select().from(accountCredentials)
    expect(credentials).toHaveLength(2)
    expect(credentials.every((row) => row.ciphertext.length > 0)).toBe(true)
  })

  it('preserves the boundary and refresh token when a reconnect omits a new refresh token', async () => {
    const first = await saveGmailConnection(db, ring, connection())
    const [firstState] = await db.select().from(mailboxSyncState)

    const second = await saveGmailConnection(
      db,
      ring,
      connection({
        emailAddress: 'USER@example.test',
        accessToken: 'access-token-2',
        accessTokenExpiresAt: new Date('2026-10-21T13:00:00Z'),
        refreshToken: undefined,
      }),
    )

    expect(second.created).toBe(false)
    expect(second.boundarySet).toBe(false)
    expect(second.refreshPreserved).toBe(true)
    expect(second.account.id).toBe(first.account.id)
    expect(second.account.emailAddress).toBe('user@example.test')

    const [secondState] = await db.select().from(mailboxSyncState)
    expect(secondState?.notificationBoundaryAt?.toISOString()).toBe(
      firstState?.notificationBoundaryAt?.toISOString(),
    )
    expect(await readCredential(db, ring, second.account.id, 'oauth_refresh_token')).toBe(
      'refresh-token-1',
    )
    expect(await readCredential(db, ring, second.account.id, 'oauth_access_token')).toBe(
      'access-token-2',
    )
  })

  it('replaces a rotated refresh token and reactivates the account', async () => {
    const first = await saveGmailConnection(db, ring, connection())
    await pauseMailAccount(db, 'user@example.test')

    const second = await saveGmailConnection(
      db,
      ring,
      connection({
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
      }),
    )

    expect(second.refreshPreserved).toBe(false)
    expect(second.account.status).toBe('active')
    expect(await readCredential(db, ring, first.account.id, 'oauth_refresh_token')).toBe(
      'refresh-token-2',
    )
  })

  it('refuses a first connection without a refresh token and writes nothing', async () => {
    await expect(
      saveGmailConnection(db, ring, connection({ refreshToken: undefined })),
    ).rejects.toThrow(/refresh token/)

    expect(await db.select().from(accounts)).toHaveLength(0)
    expect(await db.select().from(accountCredentials)).toHaveLength(0)
    expect(await db.select().from(mailboxSyncState)).toHaveLength(0)
  })

  it('looks up addresses case-insensitively and lists sync health without credentials', async () => {
    const saved = await saveGmailConnection(db, ring, connection())
    await markAccountAuthFailure(db, saved.account.id, 'revoked', 'expired grant')

    const found = await findAccountByEmail(db, 'USER@EXAMPLE.TEST')
    expect(found?.id).toBe(saved.account.id)

    const [summary] = await listAccountSummaries(db)
    expect(summary).toMatchObject({
      id: saved.account.id,
      emailAddress: 'user@example.test',
      status: 'revoked',
      lastError: 'expired grant',
    })
    expect(summary?.notificationBoundaryAt).toBeInstanceOf(Date)
  })
})

describe('account pause/resume controls', () => {
  it('pauses and resumes a connected account', async () => {
    const saved = await saveGmailConnection(db, ring, connection())

    const paused = await pauseMailAccount(db, 'user@example.test')
    expect(paused.status).toBe('paused')

    const resumed = await resumeMailAccount(db, 'user@example.test')
    expect(resumed.status).toBe('active')
    expect(resumed.id).toBe(saved.account.id)
  })

  it('refuses to resume a revoked account and points to reconnect', async () => {
    const saved = await saveGmailConnection(db, ring, connection())
    await markAccountAuthFailure(db, saved.account.id, 'revoked', 'invalid_grant')

    await expect(resumeMailAccount(db, 'user@example.test')).rejects.toMatchObject({
      name: 'MailAccountError',
      reason: 'revoked',
    })
  })

  it('refuses to resume without the gmail.readonly grant', async () => {
    const saved = await saveGmailConnection(db, ring, connection({ grantedScopes: [OTHER_SCOPE] }))
    await pauseMailAccount(db, 'user@example.test')

    await expect(resumeMailAccount(db, 'user@example.test')).rejects.toMatchObject({
      name: 'MailAccountError',
      reason: 'missing_scope',
    })
    expect(saved.account.id).toBeTruthy()
  })
})
