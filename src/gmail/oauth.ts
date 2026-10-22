import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import type { GmailOAuthConfig } from '../config.js'
import {
  GMAIL_READONLY_SCOPE,
  OAUTH_CALLBACK_PATH,
  OAUTH_FLOW_TIMEOUT_MS,
  OAUTH_LOOPBACK_HOST,
} from './constants.js'

export type { GmailOAuthConfig } from '../config.js'

export interface PkcePair {
  verifier: string
  challenge: string
}

export function createOAuth2Client(config: GmailOAuthConfig): OAuth2Client {
  return new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret })
}

/** RFC 7636 S256 PKCE pair; the verifier is never persisted or logged. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** One-use, high-entropy OAuth state value. */
export function createOAuthState(): string {
  return randomBytes(32).toString('base64url')
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export interface GmailAuthUrlOptions {
  gmail: GmailOAuthConfig
  redirectUri: string
  state: string
  codeChallenge: string
  /** Pre-selects the intended account in Google's chooser; verification still checks it. */
  loginHint?: string
}

/** Least-privilege offline authorization URL using PKCE and an explicit consent prompt. */
export function buildGmailAuthUrl(options: GmailAuthUrlOptions): string {
  const client = createOAuth2Client(options.gmail)
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: false,
    response_type: 'code',
    scope: [GMAIL_READONLY_SCOPE],
    redirect_uri: options.redirectUri,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    ...(options.loginHint !== undefined ? { login_hint: options.loginHint } : {}),
  })
}

export function parseScopeString(scope: string | null | undefined): string[] {
  if (!scope) return []
  return scope
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

export type GmailScopeValidation =
  | { ok: true; scopes: string[] }
  | { ok: false; reason: 'missing_scope' | 'unexpected_scope'; scopes: string[] }

/**
 * The connector deliberately requests only gmail.readonly. Missing or unexpected grants must
 * be resolved by reconnecting before any token is persisted.
 */
export function validateGmailScopes(scopes: string[]): GmailScopeValidation {
  const unique = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort()
  if (!unique.includes(GMAIL_READONLY_SCOPE)) {
    return { ok: false, reason: 'missing_scope', scopes: unique }
  }
  if (unique.some((scope) => scope !== GMAIL_READONLY_SCOPE)) {
    return { ok: false, reason: 'unexpected_scope', scopes: unique }
  }
  return { ok: true, scopes: unique }
}

export type OAuthFlowErrorReason =
  | 'callback_path'
  | 'state_mismatch'
  | 'access_denied'
  | 'missing_code'
  | 'timeout'
  | 'server_error'

export class OAuthFlowError extends Error {
  readonly reason: OAuthFlowErrorReason

  constructor(reason: OAuthFlowErrorReason, message: string) {
    super(message)
    this.name = 'OAuthFlowError'
    this.reason = reason
  }
}

export interface OAuthCallbackServer {
  redirectUri: string
  waitForCode(): Promise<string>
  close(): Promise<void>
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/**
 * Start a one-use loopback callback server on 127.0.0.1. The server accepts exactly one
 * matching state/code, rejects everything else, and closes after the code or the bounded
 * flow timeout.
 */
export async function startOAuthCallbackServer(options: {
  state: string
  timeoutMs?: number
  callbackPath?: string
}): Promise<OAuthCallbackServer> {
  const callbackPath = options.callbackPath ?? OAUTH_CALLBACK_PATH
  const timeoutMs = options.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS
  if (timeoutMs <= 0) {
    throw new OAuthFlowError('server_error', 'OAuth flow timeout must be positive')
  }

  const server = createServer()
  let settled = false
  let timer: NodeJS.Timeout | undefined
  let resolveCode: ((code: string) => void) | undefined
  let rejectCode: ((error: Error) => void) | undefined

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // Callers may close the flow before awaiting; keep that rejection from surfacing as an
  // unhandled rejection while preserving it for an actual waiter.
  void codePromise.catch(() => undefined)

  const settle = (action: () => void): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    action()
    void closeServer(server)
  }

  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', `http://${OAUTH_LOOPBACK_HOST}`)

    if (request.method !== 'GET') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('GET only')
      return
    }
    if (url.pathname !== callbackPath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    response.setHeader('Connection', 'close')
    if (settled) {
      response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Already used')
      return
    }

    const receivedState = url.searchParams.get('state') ?? ''
    if (!timingSafeEqualString(receivedState, options.state)) {
      response
        .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Invalid OAuth state')
      settle(() =>
        rejectCode?.(
          new OAuthFlowError('state_mismatch', 'OAuth callback state did not match; retry'),
        ),
      )
      return
    }

    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      response
        .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Authorization was not granted')
      settle(() =>
        rejectCode?.(
          new OAuthFlowError(
            oauthError === 'access_denied' ? 'access_denied' : 'server_error',
            `Google authorization failed (${oauthError}); retry`,
          ),
        ),
      )
      return
    }

    const code = url.searchParams.get('code')
    if (!code) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Missing code')
      settle(() =>
        rejectCode?.(new OAuthFlowError('missing_code', 'OAuth callback had no code; retry')),
      )
      return
    }

    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        '<!doctype html><title>Gmail connected</title><p>Authorization received. You can close this window and return to the terminal.</p>',
        () => settle(() => resolveCode?.(code)),
      )
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, OAUTH_LOOPBACK_HOST, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await closeServer(server)
    throw new OAuthFlowError(
      'server_error',
      `could not start the loopback OAuth callback server: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new OAuthFlowError('server_error', 'loopback OAuth server did not expose a TCP port')
  }
  const redirectUri = `http://${OAUTH_LOOPBACK_HOST}:${(address as AddressInfo).port}${callbackPath}`

  server.on('error', (error) => {
    settle(() =>
      rejectCode?.(
        new OAuthFlowError(
          'server_error',
          `loopback OAuth server error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    )
  })

  timer = setTimeout(() => {
    settle(() =>
      rejectCode?.(
        new OAuthFlowError('timeout', 'OAuth authorization did not finish before the deadline'),
      ),
    )
  }, timeoutMs)

  return {
    redirectUri,
    waitForCode: () => codePromise,
    close: async () => {
      if (!settled) {
        settled = true
        if (timer) clearTimeout(timer)
        rejectCode?.(new OAuthFlowError('server_error', 'OAuth flow was closed'))
      }
      await closeServer(server)
    },
  }
}

/** Best-effort browser launch. The URL is always printed, so headless use still works. */
export function openBrowser(url: string): void {
  try {
    const platform = process.platform
    const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // The printed URL is the fallback.
  }
}
