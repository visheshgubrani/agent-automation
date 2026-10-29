import { isAbsolute } from 'node:path'
import { validateSiteRegistry } from './browser/sites.js'
import { type KeyRing, parseKeyRing } from './crypto/keys.js'
import type { Env } from './env.js'
import { isSupportedModel } from './llm/pricing.js'

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

export type AgentReasoningEffort = 'medium' | 'high'

/** How a browser task is prepared before approval (D056, D058). */
export type AgentStepPolicy = 'llm' | 'rules'

/**
 * Validated browser-agent config (phase 05). Present only when `AGENT_ENABLED=true`; its
 * absence leaves the heartbeat-only and mail-only worker paths unchanged.
 */
export interface AgentConfig {
  openaiApiKey: string
  model: string
  reasoningEffort: AgentReasoningEffort
  maxSteps: number
  maxOutputTokens: number
  stepTimeoutMs: number
  /** Absent means `llm`: the model loop prepares every task. */
  stepPolicy?: AgentStepPolicy
  /** Per-task model-spend cap, checked before each reservation (D044). */
  taskMaxUsd: number
  browser: {
    /** Loopback-only CDP endpoint of the browser container. */
    cdpUrl: string
    /** HTTPS Tailscale view URL sent as a Telegram URL button; carries no credentials. */
    viewUrl: string
    /** Absolute directory for screenshots, created with mode 0700. */
    artifactDir: string
    handoffTimeoutMinutes: number
    approvalTimeoutMinutes: number
  }
}

export interface BrowserCheckConfig {
  cdpUrl: string
  /** Optional: when set, the check writes its screenshot here. */
  artifactDir?: string
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
  agent?: AgentConfig
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const CDP_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])
const SECRET_QUERY_NAME = /pass|token|secret|key|auth/i

/** CDP must stay on loopback (D041); a remote endpoint would let the network drive the browser. */
export function validateCdpUrl(value: string, issues: string[]): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    issues.push('BROWSER_CDP_URL must be a URL')
    return undefined
  }
  if (!CDP_PROTOCOLS.has(url.protocol)) {
    issues.push('BROWSER_CDP_URL must use http, https, ws, or wss')
    return undefined
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    issues.push('BROWSER_CDP_URL must point at loopback (127.0.0.1, localhost, or [::1])')
    return undefined
  }
  if (url.username || url.password) {
    issues.push('BROWSER_CDP_URL must not contain credentials')
    return undefined
  }
  return value
}

/**
 * The phone view is reached privately over Tailscale Serve (HTTPS `*.ts.net`). The URL is sent
 * to Telegram, so it must never embed credentials; VNC authentication happens in the view.
 */
export function validateViewUrl(value: string, issues: string[]): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    issues.push('BROWSER_VIEW_URL must be a URL')
    return undefined
  }
  const problems: string[] = []
  if (url.protocol !== 'https:') problems.push('use https')
  if (!url.hostname.endsWith('.ts.net')) problems.push('be a Tailscale *.ts.net host')
  if (url.username || url.password) problems.push('not contain credentials')
  if ([...url.searchParams.keys()].some((name) => SECRET_QUERY_NAME.test(name))) {
    problems.push('not carry password/token query parameters')
  }
  if (url.hash.length > 1 && SECRET_QUERY_NAME.test(url.hash)) {
    problems.push('not carry password/token fragments')
  }
  if (problems.length > 0) {
    issues.push(`BROWSER_VIEW_URL must ${problems.join(', ')}`)
    return undefined
  }
  return value
}

function readAgentConfig(env: Env, issues: string[]): AgentConfig | undefined {
  const openaiApiKey = env.OPENAI_API_KEY
  if (!openaiApiKey) {
    issues.push('OPENAI_API_KEY is required when AGENT_ENABLED=true')
  }

  const model = env.AGENT_MODEL
  if (!model) {
    issues.push('AGENT_MODEL is required when AGENT_ENABLED=true')
  } else if (!isSupportedModel(model)) {
    issues.push(`AGENT_MODEL "${model}" has no configured pricing snapshot`)
  }

  const taskMaxUsd = env.AGENT_TASK_MAX_USD
  if (taskMaxUsd === undefined) {
    issues.push('AGENT_TASK_MAX_USD is required when AGENT_ENABLED=true')
  }

  const cdpUrl = validateCdpUrl(env.BROWSER_CDP_URL, issues)

  // The site registry is code, but a broken entry must stop the worker before any task runs.
  const registryIssues = validateSiteRegistry()
  for (const issue of registryIssues) issues.push(`site registry: ${issue}`)

  let viewUrl: string | undefined
  if (!env.BROWSER_VIEW_URL) {
    issues.push('BROWSER_VIEW_URL is required when AGENT_ENABLED=true')
  } else {
    viewUrl = validateViewUrl(env.BROWSER_VIEW_URL, issues)
  }

  let artifactDir: string | undefined
  if (!env.ARTIFACT_DIR) {
    issues.push('ARTIFACT_DIR is required when AGENT_ENABLED=true')
  } else if (!isAbsolute(env.ARTIFACT_DIR)) {
    issues.push('ARTIFACT_DIR must be an absolute path')
  } else {
    artifactDir = env.ARTIFACT_DIR
  }

  if (
    !openaiApiKey ||
    !model ||
    !isSupportedModel(model) ||
    taskMaxUsd === undefined ||
    !cdpUrl ||
    !viewUrl ||
    !artifactDir ||
    registryIssues.length > 0
  ) {
    return undefined
  }

  return {
    openaiApiKey,
    model,
    reasoningEffort: env.AGENT_REASONING_EFFORT,
    maxSteps: env.AGENT_MAX_STEPS,
    maxOutputTokens: env.AGENT_MAX_OUTPUT_TOKENS,
    stepTimeoutMs: env.AGENT_STEP_TIMEOUT_MS,
    stepPolicy: env.AGENT_STEP_POLICY,
    taskMaxUsd,
    browser: {
      cdpUrl,
      viewUrl,
      artifactDir,
      handoffTimeoutMinutes: env.BROWSER_HANDOFF_TIMEOUT_MINUTES,
      approvalTimeoutMinutes: env.BROWSER_APPROVAL_TIMEOUT_MINUTES,
    },
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

    if (!isSupportedModel(env.MAIL_MODEL)) {
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

  const agent = env.AGENT_ENABLED ? readAgentConfig(env, issues) : undefined

  if (!botToken || chatId === undefined || !encryption) {
    throw new ConfigError(issues)
  }

  // Mail and agent problems must fail the worker too; without this, a missing OpenAI key would be
  // silently ignored while mail remained enabled.
  if (issues.length > 0) {
    throw new ConfigError(issues)
  }

  return {
    telegram: { botToken, chatId },
    encryption,
    heartbeatCron: env.HEARTBEAT_CRON,
    ...(mail !== undefined ? { mail } : {}),
    ...(agent !== undefined ? { agent } : {}),
  }
}

/**
 * Config for `pnpm browser:check`. It needs only the loopback CDP endpoint (and optionally the
 * artifact directory), not Telegram, OpenAI, or `AGENT_ENABLED`, so the browser host can be
 * verified before the agent is enabled.
 */
export function requireBrowserCheckConfig(env: Env): BrowserCheckConfig {
  const issues: string[] = []
  const cdpUrl = validateCdpUrl(env.BROWSER_CDP_URL, issues)

  let artifactDir: string | undefined
  if (env.ARTIFACT_DIR !== undefined) {
    if (isAbsolute(env.ARTIFACT_DIR)) artifactDir = env.ARTIFACT_DIR
    else issues.push('ARTIFACT_DIR must be an absolute path')
  }

  if (!cdpUrl || issues.length > 0) {
    throw new ConfigError(issues, 'browser check')
  }

  return { cdpUrl, ...(artifactDir !== undefined ? { artifactDir } : {}) }
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
