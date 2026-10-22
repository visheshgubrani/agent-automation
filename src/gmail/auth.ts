import { gmail, type gmail_v1 } from '@googleapis/gmail'
import { eq } from 'drizzle-orm'
import type { Credentials, OAuth2Client } from 'google-auth-library'
import type { GmailOAuthConfig } from '../config.js'
import type { KeyRing } from '../crypto/keys.js'
import type { Db } from '../db/index.js'
import { type AccountRow, markAccountAuthFailure } from '../db/queries/accounts.js'
import { readCredentialRecord, upsertCredential } from '../db/queries/credentials.js'
import { accounts, mailboxSyncState } from '../db/schema/index.js'
import { errorDetails } from '../errors.js'
import { GMAIL_READONLY_SCOPE } from './constants.js'
import { createOAuth2Client, parseScopeString, validateGmailScopes } from './oauth.js'

/** Refresh this far before expiry so an in-flight request does not start with a dead token. */
const EXPIRY_MARGIN_MS = 60_000
const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000

export type GmailAuthFailureReason =
  | 'account_not_found'
  | 'missing_refresh_token'
  | 'revoked'
  | 'missing_scope'
  | 'unexpected_scope'
  | 'permanent'
  | 'transient'

export class GmailAuthError extends Error {
  readonly reason: GmailAuthFailureReason
  readonly accountId?: string

  constructor(reason: GmailAuthFailureReason, message: string, accountId?: string) {
    super(message)
    this.name = 'GmailAuthError'
    this.reason = reason
    this.accountId = accountId
  }
}

/** The subset of google-auth-library's OAuth2Client used by the lifecycle helpers. */
export interface OAuthClientLike {
  setCredentials(credentials: Credentials): void
  refreshAccessToken(): Promise<{ credentials: Credentials }>
  getTokenInfo(accessToken: string): Promise<{ scopes: string[] }>
}

export type OAuthClientFactory = (config: GmailOAuthConfig) => OAuthClientLike

export interface GmailAuthorization {
  client: OAuthClientLike
  accessTokenExpiresAt: Date
  grantedScopes: string[]
  /** False when a still-valid stored access token was reused. */
  refreshed: boolean
}

export interface GmailAuthorizationOptions {
  db: Db
  ring: KeyRing
  gmail: GmailOAuthConfig
  accountId: string
  /** Force a refresh even when the stored access token is still valid (e.g. after a 401). */
  forceRefresh?: boolean
  /** Test seam; defaults to a real OAuth2Client. */
  clientFactory?: OAuthClientFactory
}

interface GoogleErrorInfo {
  status?: number
  code?: string
}

function googleErrorInfo(error: unknown, depth = 0): GoogleErrorInfo {
  if (error == null || typeof error !== 'object' || depth > 5) return {}

  const candidate = error as {
    response?: { status?: unknown; data?: unknown }
    code?: unknown
    cause?: unknown
  }
  const status =
    typeof candidate.response?.status === 'number' ? candidate.response.status : undefined
  let code: string | undefined
  const data = candidate.response?.data
  if (data && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string' && value.length > 0) {
      code = value
    }
  }
  if (!code && typeof candidate.code === 'string' && candidate.code.length > 0) {
    code = candidate.code
  }
  if (candidate.cause !== undefined) {
    const nested = googleErrorInfo(candidate.cause, depth + 1)
    return { status: status ?? nested.status, code: code ?? nested.code }
  }
  return { status, code }
}

type RefreshFailure = {
  kind: 'revoked' | 'permanent' | 'transient'
  reason: string
}

function classifyRefreshFailure(error: unknown): RefreshFailure {
  const { status, code } = googleErrorInfo(error)
  const normalizedCode = code?.toLowerCase()

  if (normalizedCode === 'invalid_grant' || normalizedCode === 'access_denied') {
    return {
      kind: 'revoked',
      reason: 'Google authorization expired or was revoked (invalid_grant)',
    }
  }
  if (
    normalizedCode === 'invalid_client' ||
    normalizedCode === 'unauthorized_client' ||
    normalizedCode === 'invalid_request' ||
    normalizedCode === 'insufficient_scope' ||
    status === 400 ||
    status === 401 ||
    status === 403
  ) {
    return {
      kind: 'permanent',
      reason: `Google authorization failed permanently${normalizedCode ? ` (${normalizedCode})` : status ? ` (HTTP ${status})` : ''}`,
    }
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    return {
      kind: 'transient',
      reason: `Google authorization is temporarily unavailable (HTTP ${status})`,
    }
  }

  const nodeCode = errorDetails(error).code
  return {
    kind: 'transient',
    reason: `Google authorization request failed${nodeCode ? ` (${nodeCode})` : ''}`,
  }
}

async function markFailure(
  options: GmailAuthorizationOptions,
  account: AccountRow,
  failure: RefreshFailure,
): Promise<never> {
  if (failure.kind === 'transient') {
    throw new GmailAuthError('transient', failure.reason, account.id)
  }

  const status = failure.kind === 'revoked' ? 'revoked' : 'error'
  const message =
    status === 'revoked'
      ? `${failure.reason}; run pnpm gmail:connect --email ${account.emailAddress}`
      : `${failure.reason}; reconnect the account with pnpm gmail:connect --email ${account.emailAddress}`
  await markAccountAuthFailure(options.db, account.id, status, message)
  throw new GmailAuthError(status === 'revoked' ? 'revoked' : 'permanent', message, account.id)
}

async function markRecovered(db: Db, account: AccountRow): Promise<void> {
  if (account.status !== 'error') return
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .update(accounts)
      .set({ status: 'active', updatedAt: now })
      .where(eq(accounts.id, account.id))
    await tx
      .update(mailboxSyncState)
      .set({ lastError: null, updatedAt: now })
      .where(eq(mailboxSyncState.accountId, account.id))
  })
}

/**
 * Return a usable Gmail OAuth client for one account. A still-valid stored access token is
 * reused; otherwise the refresh token is exchanged, rotated refresh tokens are re-encrypted,
 * and access-token expiry is persisted. Permanent auth failures mark the account visibly;
 * transient failures leave it active for retry.
 */
export async function getGmailAuthorization(
  options: GmailAuthorizationOptions,
): Promise<GmailAuthorization> {
  const [account] = await options.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, options.accountId))
    .limit(1)

  if (!account) {
    throw new GmailAuthError(
      'account_not_found',
      `account ${options.accountId} was not found`,
      options.accountId,
    )
  }
  if (account.status === 'revoked') {
    throw new GmailAuthError(
      'revoked',
      `account ${account.emailAddress} is revoked; run pnpm gmail:connect --email ${account.emailAddress}`,
      account.id,
    )
  }
  if (!account.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
    const message = `account ${account.emailAddress} lacks ${GMAIL_READONLY_SCOPE}; reconnect it`
    await markAccountAuthFailure(options.db, account.id, 'error', message)
    throw new GmailAuthError('missing_scope', message, account.id)
  }

  const clientFactory = options.clientFactory ?? createOAuth2Client
  const client = clientFactory(options.gmail)

  if (!options.forceRefresh) {
    const access = await readCredentialRecord(
      options.db,
      options.ring,
      account.id,
      'oauth_access_token',
    )
    if (
      access?.expiresAt &&
      access.expiresAt.getTime() > Date.now() + EXPIRY_MARGIN_MS &&
      access.plaintext.length > 0
    ) {
      await markRecovered(options.db, account)
      client.setCredentials({ access_token: access.plaintext })
      return {
        client,
        accessTokenExpiresAt: access.expiresAt,
        grantedScopes: account.grantedScopes,
        refreshed: false,
      }
    }
  }

  const refresh = await readCredentialRecord(
    options.db,
    options.ring,
    account.id,
    'oauth_refresh_token',
  )
  if (!refresh || refresh.plaintext.length === 0) {
    const message = `account ${account.emailAddress} has no stored refresh token; run pnpm gmail:connect --email ${account.emailAddress}`
    await markAccountAuthFailure(options.db, account.id, 'revoked', message)
    throw new GmailAuthError('missing_refresh_token', message, account.id)
  }

  client.setCredentials({ refresh_token: refresh.plaintext })

  let credentials: Credentials
  try {
    const response = await client.refreshAccessToken()
    credentials = response.credentials
  } catch (error) {
    return markFailure(options, account, classifyRefreshFailure(error))
  }

  const accessToken = credentials.access_token
  if (!accessToken) {
    return markFailure(options, account, {
      kind: 'permanent',
      reason: 'Google returned no access token',
    })
  }

  let scopes = parseScopeString(credentials.scope)
  let tokenInfoExpiry: number | undefined
  if (scopes.length === 0) {
    try {
      const info = await client.getTokenInfo(accessToken)
      scopes = info.scopes ?? []
      tokenInfoExpiry = (info as { expiry_date?: number }).expiry_date
    } catch (error) {
      return markFailure(options, account, classifyRefreshFailure(error))
    }
  }

  const scopeCheck = validateGmailScopes(scopes)
  if (!scopeCheck.ok) {
    const message =
      scopeCheck.reason === 'missing_scope'
        ? `Google did not grant ${GMAIL_READONLY_SCOPE}; reconnect the account`
        : `Google returned unexpected scopes (${scopeCheck.scopes.join(', ')}); reconnect with only gmail.readonly`
    await markAccountAuthFailure(options.db, account.id, 'error', message)
    throw new GmailAuthError(
      scopeCheck.reason === 'missing_scope' ? 'missing_scope' : 'unexpected_scope',
      message,
      account.id,
    )
  }

  const expiresAt = credentials.expiry_date
    ? new Date(credentials.expiry_date)
    : tokenInfoExpiry
      ? new Date(tokenInfoExpiry)
      : new Date(Date.now() + DEFAULT_ACCESS_TOKEN_LIFETIME_MS)

  const now = new Date()
  const recovered = account.status === 'error'
  await options.db.transaction(async (tx) => {
    await upsertCredential(tx, options.ring, {
      accountId: account.id,
      kind: 'oauth_access_token',
      plaintext: accessToken,
      expiresAt,
    })
    if (credentials.refresh_token) {
      await upsertCredential(tx, options.ring, {
        accountId: account.id,
        kind: 'oauth_refresh_token',
        plaintext: credentials.refresh_token,
      })
    }
    await tx
      .update(accounts)
      .set({
        grantedScopes: scopeCheck.scopes,
        ...(recovered ? { status: 'active' as const } : {}),
        updatedAt: now,
      })
      .where(eq(accounts.id, account.id))
    if (recovered) {
      await tx
        .update(mailboxSyncState)
        .set({ lastError: null, updatedAt: now })
        .where(eq(mailboxSyncState.accountId, account.id))
    }
  })

  return {
    client,
    accessTokenExpiresAt: expiresAt,
    grantedScopes: scopeCheck.scopes,
    refreshed: true,
  }
}

export interface AuthorizedGmailClient {
  gmail: gmail_v1.Gmail
  accessTokenExpiresAt: Date
  grantedScopes: string[]
  refreshed: boolean
}

/** Gmail API client backed by the account's encrypted credentials. */
export async function createAuthorizedGmailClient(
  options: GmailAuthorizationOptions,
): Promise<AuthorizedGmailClient> {
  const authorization = await getGmailAuthorization(options)
  return {
    gmail: gmail({ version: 'v1', auth: authorization.client as OAuth2Client }),
    accessTokenExpiresAt: authorization.accessTokenExpiresAt,
    grantedScopes: authorization.grantedScopes,
    refreshed: authorization.refreshed,
  }
}
