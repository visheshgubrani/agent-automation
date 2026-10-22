import { eq } from 'drizzle-orm'
import type { Credentials } from 'google-auth-library'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { parseKeyRing } from '../src/crypto/keys.js'
import { saveGmailConnection } from '../src/db/queries/accounts.js'
import { readCredential, readCredentialRecord } from '../src/db/queries/credentials.js'
import { accountCredentials, accounts, mailboxSyncState } from '../src/db/schema/index.js'
import { GmailAuthError, getGmailAuthorization, type OAuthClientLike } from '../src/gmail/auth.js'
import { GMAIL_READONLY_SCOPE } from '../src/gmail/constants.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

const ring = parseKeyRing(process.env.TOKEN_ENCRYPTION_KEYS ?? '', 1)
const GMAIL = { clientId: 'client-id', clientSecret: 'client-secret' }
const OTHER_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata'

class FakeOAuthClient implements OAuthClientLike {
  credentials: Credentials | undefined
  refreshCalls = 0
  tokenInfoCalls = 0

  constructor(
    private readonly refreshResult: Credentials | Error,
    private readonly scopes: string[] = [GMAIL_READONLY_SCOPE],
  ) {}

  setCredentials(credentials: Credentials): void {
    this.credentials = credentials
  }

  async refreshAccessToken(): Promise<{ credentials: Credentials }> {
    this.refreshCalls += 1
    if (this.refreshResult instanceof Error) throw this.refreshResult
    return { credentials: this.refreshResult }
  }

  async getTokenInfo(): Promise<{ scopes: string[] }> {
    this.tokenInfoCalls += 1
    return { scopes: this.scopes }
  }
}

beforeEach(truncateAllTables)
afterAll(closeTestDb)

async function connect(overrides: Partial<Parameters<typeof saveGmailConnection>[2]> = {}) {
  return saveGmailConnection(db, ring, {
    emailAddress: 'user@example.test',
    grantedScopes: [GMAIL_READONLY_SCOPE],
    accessToken: 'cached-access',
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    refreshToken: 'stored-refresh',
    ...overrides,
  })
}

describe('Gmail token lifecycle', () => {
  it('reuses a still-valid stored access token without refreshing', async () => {
    const saved = await connect()
    const fake = new FakeOAuthClient(new Error('should not refresh'))

    const auth = await getGmailAuthorization({
      db,
      ring,
      gmail: GMAIL,
      accountId: saved.account.id,
      clientFactory: () => fake,
    })

    expect(auth.refreshed).toBe(false)
    expect(auth.grantedScopes).toEqual([GMAIL_READONLY_SCOPE])
    expect(fake.refreshCalls).toBe(0)
    expect(fake.credentials?.access_token).toBe('cached-access')
  })

  it('refreshes an expired token and persists the rotated refresh token', async () => {
    const saved = await connect({
      accessTokenExpiresAt: new Date(Date.now() - 1_000),
    })
    const expiry = Date.now() + 60 * 60 * 1000
    const fake = new FakeOAuthClient({
      access_token: 'refreshed-access',
      refresh_token: 'rotated-refresh',
      expiry_date: expiry,
      scope: GMAIL_READONLY_SCOPE,
    })

    const auth = await getGmailAuthorization({
      db,
      ring,
      gmail: GMAIL,
      accountId: saved.account.id,
      clientFactory: () => fake,
    })

    expect(auth.refreshed).toBe(true)
    expect(auth.accessTokenExpiresAt.toISOString()).toBe(new Date(expiry).toISOString())
    expect(fake.refreshCalls).toBe(1)
    expect(await readCredential(db, ring, saved.account.id, 'oauth_access_token')).toBe(
      'refreshed-access',
    )
    expect(await readCredential(db, ring, saved.account.id, 'oauth_refresh_token')).toBe(
      'rotated-refresh',
    )
    const access = await readCredentialRecord(db, ring, saved.account.id, 'oauth_access_token')
    expect(access?.expiresAt?.toISOString()).toBe(new Date(expiry).toISOString())
  })

  it('preserves the stored refresh token when Google omits a replacement', async () => {
    const saved = await connect({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
    const fake = new FakeOAuthClient({
      access_token: 'refreshed-access',
      expiry_date: Date.now() + 60 * 60 * 1000,
      scope: GMAIL_READONLY_SCOPE,
    })

    await getGmailAuthorization({
      db,
      ring,
      gmail: GMAIL,
      accountId: saved.account.id,
      clientFactory: () => fake,
    })

    expect(await readCredential(db, ring, saved.account.id, 'oauth_refresh_token')).toBe(
      'stored-refresh',
    )
    expect(await db.select().from(accountCredentials)).toHaveLength(2)
  })

  it('falls back to token-info scopes when the refresh response omits scope', async () => {
    const saved = await connect({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
    const fake = new FakeOAuthClient(
      {
        access_token: 'refreshed-access',
        expiry_date: Date.now() + 60 * 60 * 1000,
      },
      [GMAIL_READONLY_SCOPE],
    )

    const auth = await getGmailAuthorization({
      db,
      ring,
      gmail: GMAIL,
      accountId: saved.account.id,
      clientFactory: () => fake,
    })

    expect(fake.tokenInfoCalls).toBe(1)
    expect(auth.grantedScopes).toEqual([GMAIL_READONLY_SCOPE])
  })

  it('marks invalid_grant as revoked and exposes a reconnect instruction', async () => {
    const saved = await connect({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
    const fake = new FakeOAuthClient(
      Object.assign(new Error('invalid grant'), {
        response: { status: 400, data: { error: 'invalid_grant' } },
      }),
    )

    await expect(
      getGmailAuthorization({
        db,
        ring,
        gmail: GMAIL,
        accountId: saved.account.id,
        clientFactory: () => fake,
      }),
    ).rejects.toMatchObject({ reason: 'revoked' })

    const [account] = await db.select().from(accounts).where(eq(accounts.id, saved.account.id))
    expect(account?.status).toBe('revoked')
    const [state] = await db.select().from(mailboxSyncState)
    expect(state?.lastError).toContain('pnpm gmail:connect')
  })

  it('marks a missing scope as an error and does not keep the account active', async () => {
    const saved = await connect({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
    const fake = new FakeOAuthClient(
      {
        access_token: 'refreshed-access',
        expiry_date: Date.now() + 60 * 60 * 1000,
        scope: OTHER_SCOPE,
      },
      [OTHER_SCOPE],
    )

    await expect(
      getGmailAuthorization({
        db,
        ring,
        gmail: GMAIL,
        accountId: saved.account.id,
        clientFactory: () => fake,
      }),
    ).rejects.toBeInstanceOf(GmailAuthError)

    const [account] = await db.select().from(accounts).where(eq(accounts.id, saved.account.id))
    expect(account?.status).toBe('error')
    const [state] = await db.select().from(mailboxSyncState)
    expect(state?.lastError).toContain('gmail.readonly')
  })

  it('leaves the account active on a transient refresh failure', async () => {
    const saved = await connect({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
    const fake = new FakeOAuthClient(
      Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    )

    await expect(
      getGmailAuthorization({
        db,
        ring,
        gmail: GMAIL,
        accountId: saved.account.id,
        clientFactory: () => fake,
      }),
    ).rejects.toMatchObject({ reason: 'transient' })

    const [account] = await db.select().from(accounts).where(eq(accounts.id, saved.account.id))
    expect(account?.status).toBe('active')
    const [state] = await db.select().from(mailboxSyncState)
    expect(state?.lastError).toBeNull()
  })

  it('marks a missing refresh token as revoked', async () => {
    const saved = await connect()
    await db.delete(accountCredentials).where(eq(accountCredentials.kind, 'oauth_refresh_token'))

    await expect(
      getGmailAuthorization({
        db,
        ring,
        gmail: GMAIL,
        accountId: saved.account.id,
        forceRefresh: true,
        clientFactory: () => new FakeOAuthClient(new Error('must not refresh')),
      }),
    ).rejects.toMatchObject({ reason: 'missing_refresh_token' })

    const [account] = await db.select().from(accounts).where(eq(accounts.id, saved.account.id))
    expect(account?.status).toBe('revoked')
  })
})
