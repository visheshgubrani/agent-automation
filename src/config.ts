import { type KeyRing, parseKeyRing } from './crypto/keys.js'
import type { Env } from './env.js'
import { isSupportedMailModel } from './mail/pricing.js'

export type MailReasoningEffort = 'medium' | 'high'

export interface GmailOAuthConfig {
  clientId: string
  clientSecret: string
}

/**
 * Validated mail config. Present only when `MAIL_ENABLED=true`; its absence is the
 * heartbeat-only worker path. Secrets here are never logged.
 */
export interface MailConfig {
  gmail: GmailOAuthConfig
  openaiApiKey: string
  model: string
  reasoningEffort: MailReasoningEffort
  maxInputChars: number
  maxOutputTokens: number
  requestTimeoutMs: number
  /** Delay between Gmail API calls to stay within project quota during backfill. */
  gmailRequestDelayMs: number
}

export interface GmailConnectConfig {
  gmail: GmailOAuthConfig
  encryption: KeyRing
}

export interface WorkerConfig {
  telegram: {
    botToken: string
    chatId: number
  }
  encryption: KeyRing
  heartbeatCron: string
  mail?: MailConfig
}

export class ConfigError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[], context = 'worker') {
    super(`Invalid ${context} configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

function readEncryption(env: Env, issues: string[]): KeyRing | undefined {
  const keys = env.TOKEN_ENCRYPTION_KEYS
  if (!keys) {
    issues.push('TOKEN_ENCRYPTION_KEYS is required')
  }

  const activeVersion = env.TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION
  if (activeVersion === undefined) {
    issues.push('TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION is required')
  }

  if (!keys || activeVersion === undefined) {
    return undefined
  }

  try {
    return parseKeyRing(keys, activeVersion)
  } catch (error) {
    issues.push(`TOKEN_ENCRYPTION_KEYS: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Validate the config only the worker needs. The API can start with none of these set.
 *
 * All problems are collected so a misconfigured worker reports every missing/invalid value at once
 * instead of failing one variable at a time. Mail credentials are required only when mail is
 * enabled, so the worker stays runnable for the heartbeat-only path.
 */
export function requireWorkerConfig(env: Env): WorkerConfig {
  const issues: string[] = []

  const botToken = env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    issues.push('TELEGRAM_BOT_TOKEN is required')
  }

  const chatId = env.TELEGRAM_CHAT_ID
  if (chatId === undefined) {
    issues.push('TELEGRAM_CHAT_ID is required (safe integer)')
  }

  const encryption = readEncryption(env, issues)

  let mail: MailConfig | undefined
  if (env.MAIL_ENABLED) {
    const gmailClientId = env.GMAIL_CLIENT_ID
    if (!gmailClientId) {
      issues.push('GMAIL_CLIENT_ID is required when MAIL_ENABLED=true')
    }

    const gmailClientSecret = env.GMAIL_CLIENT_SECRET
    if (!gmailClientSecret) {
      issues.push('GMAIL_CLIENT_SECRET is required when MAIL_ENABLED=true')
    }

    const openaiApiKey = env.OPENAI_API_KEY
    if (!openaiApiKey) {
      issues.push('OPENAI_API_KEY is required when MAIL_ENABLED=true')
    }

    if (!isSupportedMailModel(env.MAIL_MODEL)) {
      issues.push(`MAIL_MODEL "${env.MAIL_MODEL}" has no configured pricing snapshot`)
    }

    if (gmailClientId && gmailClientSecret && openaiApiKey) {
      mail = {
        gmail: { clientId: gmailClientId, clientSecret: gmailClientSecret },
        openaiApiKey,
        model: env.MAIL_MODEL,
        reasoningEffort: env.MAIL_REASONING_EFFORT,
        maxInputChars: env.MAIL_MAX_INPUT_CHARS,
        maxOutputTokens: env.MAIL_MAX_OUTPUT_TOKENS,
        requestTimeoutMs: env.MAIL_REQUEST_TIMEOUT_MS,
        gmailRequestDelayMs: env.GMAIL_REQUEST_DELAY_MS,
      }
    }
  }

  if (!botToken || chatId === undefined || !encryption) {
    throw new ConfigError(issues)
  }

  // Mail problems must fail the worker too; without this, a missing OpenAI key would be
  // silently ignored while mail remained enabled.
  if (issues.length > 0) {
    throw new ConfigError(issues)
  }

  return {
    telegram: { botToken, chatId },
    encryption,
    heartbeatCron: env.HEARTBEAT_CRON,
    ...(mail !== undefined ? { mail } : {}),
  }
}

/**
 * Config for the local Gmail account-connect command. It needs the Desktop OAuth client and
 * the encryption key ring, but not Telegram, OpenAI, or `MAIL_ENABLED` — accounts can be
 * connected before mail processing is enabled in the worker.
 */
export function requireGmailConnectConfig(env: Env): GmailConnectConfig {
  const issues: string[] = []

  const clientId = env.GMAIL_CLIENT_ID
  if (!clientId) {
    issues.push('GMAIL_CLIENT_ID is required for Gmail account connection')
  }

  const clientSecret = env.GMAIL_CLIENT_SECRET
  if (!clientSecret) {
    issues.push('GMAIL_CLIENT_SECRET is required for Gmail account connection')
  }

  const encryption = readEncryption(env, issues)

  if (!clientId || !clientSecret || !encryption) {
    throw new ConfigError(issues, 'Gmail connection')
  }

  return {
    gmail: { clientId, clientSecret },
    encryption,
  }
}
