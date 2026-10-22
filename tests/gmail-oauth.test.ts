import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GMAIL_READONLY_SCOPE } from '../src/gmail/constants.js'
import { assertGmailAccountMatches, GmailConnectError } from '../src/gmail/errors.js'
import {
  buildGmailAuthUrl,
  createOAuthState,
  createPkcePair,
  OAuthFlowError,
  parseScopeString,
  startOAuthCallbackServer,
  timingSafeEqualString,
  validateGmailScopes,
} from '../src/gmail/oauth.js'

const GMAIL = { clientId: 'client-id', clientSecret: 'client-secret' }

describe('OAuth request construction', () => {
  it('creates an S256 PKCE pair and a high-entropy one-use state', () => {
    const pair = createPkcePair()
    const expected = createHash('sha256').update(pair.verifier).digest('base64url')

    expect(pair.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pair.challenge).toBe(expected)
    expect(createOAuthState()).not.toBe(createOAuthState())
    expect(createOAuthState().length).toBeGreaterThanOrEqual(32)
    expect(timingSafeEqualString('same', 'same')).toBe(true)
    expect(timingSafeEqualString('same', 'different')).toBe(false)
  })

  it('builds an offline, consent, readonly-only authorization URL with PKCE', () => {
    const url = new URL(
      buildGmailAuthUrl({
        gmail: GMAIL,
        redirectUri: 'http://127.0.0.1:4567/oauth2callback',
        state: 'state-value',
        codeChallenge: 'challenge-value',
        loginHint: 'user@example.test',
      }),
    )

    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('include_granted_scopes')).toBe('false')
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE)
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4567/oauth2callback')
    expect(url.searchParams.get('state')).toBe('state-value')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('login_hint')).toBe('user@example.test')
  })

  it('validates granted scopes and rejects missing/unexpected grants', () => {
    expect(validateGmailScopes([GMAIL_READONLY_SCOPE])).toEqual({
      ok: true,
      scopes: [GMAIL_READONLY_SCOPE],
    })
    expect(validateGmailScopes([GMAIL_READONLY_SCOPE, GMAIL_READONLY_SCOPE])).toEqual({
      ok: true,
      scopes: [GMAIL_READONLY_SCOPE],
    })

    expect(validateGmailScopes([])).toMatchObject({ ok: false, reason: 'missing_scope' })
    expect(validateGmailScopes(['https://www.googleapis.com/auth/gmail.metadata'])).toMatchObject({
      ok: false,
      reason: 'missing_scope',
    })
    expect(
      validateGmailScopes([GMAIL_READONLY_SCOPE, 'https://www.googleapis.com/auth/gmail.metadata']),
    ).toMatchObject({ ok: false, reason: 'unexpected_scope' })

    expect(parseScopeString(`${GMAIL_READONLY_SCOPE}  other`)).toEqual([
      GMAIL_READONLY_SCOPE,
      'other',
    ])
    expect(parseScopeString(null)).toEqual([])
  })
})

describe('Gmail account verification', () => {
  it('matches the authorized profile case-insensitively', () => {
    expect(assertGmailAccountMatches('User@Example.test', 'user@example.test')).toBe(
      'user@example.test',
    )
  })

  it('rejects a different authorized account', () => {
    expect(() => assertGmailAccountMatches('intended@example.test', 'other@example.test')).toThrow(
      GmailConnectError,
    )
    try {
      assertGmailAccountMatches('intended@example.test', 'other@example.test')
    } catch (error) {
      expect((error as GmailConnectError).reason).toBe('email_mismatch')
      expect(error instanceof Error ? error.message : '').toContain('other@example.test')
    }
  })
})

describe('loopback OAuth callback server', () => {
  it('listens only on 127.0.0.1 and resolves one matching code', async () => {
    const state = 'expected-state'
    const flow = await startOAuthCallbackServer({ state, timeoutMs: 2_000 })
    try {
      expect(flow.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/)

      const response = await fetch(
        `${flow.redirectUri}?state=${encodeURIComponent(state)}&code=authorization-code`,
      )
      expect(response.status).toBe(200)
      await expect(flow.waitForCode()).resolves.toBe('authorization-code')
    } finally {
      await flow.close()
    }
  })

  it('rejects a mismatched state and closes', async () => {
    const flow = await startOAuthCallbackServer({ state: 'expected-state', timeoutMs: 2_000 })
    try {
      const result = expect(flow.waitForCode()).rejects.toMatchObject({
        name: 'OAuthFlowError',
        reason: 'state_mismatch',
      })
      const response = await fetch(`${flow.redirectUri}?state=wrong&code=authorization-code`)
      expect(response.status).toBe(400)
      await result
      await expect(flow.waitForCode()).rejects.toBeInstanceOf(OAuthFlowError)
    } finally {
      await flow.close()
    }
  })

  it('times out an abandoned flow', async () => {
    const flow = await startOAuthCallbackServer({ state: 'expected-state', timeoutMs: 50 })
    try {
      await expect(flow.waitForCode()).rejects.toMatchObject({ reason: 'timeout' })
    } finally {
      await flow.close()
    }
  })
})
