import { gmail } from '@googleapis/gmail'
import type { Credentials } from 'google-auth-library'
import type { GmailConnectConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { type GmailConnectionResult, saveGmailConnection } from '../db/queries/accounts.js'
import { normalizeEmailAddress } from '../mail/normalize.js'
import { assertGmailAccountMatches, GmailConnectError } from './errors.js'
import {
  buildGmailAuthUrl,
  createOAuth2Client,
  createOAuthState,
  createPkcePair,
  startOAuthCallbackServer,
  validateGmailScopes,
} from './oauth.js'

export interface ConnectGmailOptions {
  db: Db
  config: GmailConnectConfig
  /** Expected account address; must match the account Google authorizes. */
  email: string
  /** Called with the authorization URL so the CLI can print/open it. */
  onAuthUrl?: (url: string) => void
  flowTimeoutMs?: number
}

export interface ConnectGmailResult extends GmailConnectionResult {
  authorizedEmail: string
  grantedScopes: string[]
}

/**
 * Run the local Desktop OAuth flow, verify the authorized account and least-privilege scope,
 * then atomically persist the account and encrypted credential envelopes. No credential is
 * written until profile and scope verification succeed.
 */
export async function connectGmailAccount(
  options: ConnectGmailOptions,
): Promise<ConnectGmailResult> {
  const expectedEmail = normalizeEmailAddress(options.email)
  const state = createOAuthState()
  const pkce = createPkcePair()
  const callback = await startOAuthCallbackServer({
    state,
    ...(options.flowTimeoutMs !== undefined ? { timeoutMs: options.flowTimeoutMs } : {}),
  })

  try {
    const authUrl = buildGmailAuthUrl({
      gmail: options.config.gmail,
      redirectUri: callback.redirectUri,
      state,
      codeChallenge: pkce.challenge,
      loginHint: expectedEmail,
    })
    options.onAuthUrl?.(authUrl)

    const code = await callback.waitForCode()
    const oauth = createOAuth2Client(options.config.gmail)

    let tokens: Credentials
    try {
      const response = await oauth.getToken({
        code,
        codeVerifier: pkce.verifier,
        redirect_uri: callback.redirectUri,
      })
      tokens = response.tokens
    } catch {
      throw new GmailConnectError(
        'token_exchange_failed',
        'Google token exchange failed; check the Desktop OAuth client and consent configuration',
      )
    }

    const accessToken = tokens.access_token
    if (!accessToken) {
      throw new GmailConnectError('missing_access_token', 'Google returned no access token')
    }
    oauth.setCredentials(tokens)

    let scopes: string[]
    try {
      const info = await oauth.getTokenInfo(accessToken)
      scopes = info.scopes ?? []
    } catch {
      throw new GmailConnectError(
        'scope_verification_failed',
        'could not verify the granted Google scopes; retry the connection',
      )
    }

    const scopeCheck = validateGmailScopes(scopes)
    if (!scopeCheck.ok) {
      throw new GmailConnectError(
        scopeCheck.reason,
        scopeCheck.reason === 'missing_scope'
          ? 'the authorization did not grant gmail.readonly; retry and approve the requested permission'
          : `the authorization granted unexpected scopes (${scopeCheck.scopes.join(', ')}); retry with only gmail.readonly`,
      )
    }

    let profileEmail: string
    try {
      const api = gmail({ version: 'v1', auth: oauth })
      const profile = await api.users.getProfile({ userId: 'me' })
      profileEmail = normalizeEmailAddress(profile.data.emailAddress ?? '')
    } catch {
      throw new GmailConnectError(
        'profile_verification_failed',
        'could not read the Gmail profile; confirm the Gmail API is enabled and gmail.readonly was granted',
      )
    }

    const authorizedEmail = assertGmailAccountMatches(expectedEmail, profileEmail)

    const saved = await saveGmailConnection(options.db, options.config.encryption, {
      emailAddress: authorizedEmail,
      grantedScopes: scopeCheck.scopes,
      accessToken,
      ...(tokens.expiry_date ? { accessTokenExpiresAt: new Date(tokens.expiry_date) } : {}),
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    })

    return {
      ...saved,
      authorizedEmail,
      grantedScopes: scopeCheck.scopes,
    }
  } finally {
    await callback.close()
  }
}
