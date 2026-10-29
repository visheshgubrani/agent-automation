import { z } from 'zod'
import { MAX_KEY_VERSION } from './crypto/keys.js'

/**
 * Default daily heartbeat. The schedule is validated by pg-boss when the worker starts;
 * the cron is UTC. An every-two-minute cron can be used temporarily for the scheduled exit test.
 */
export const DEFAULT_HEARTBEAT_CRON = '0 9 * * *'

export const DEFAULT_MAIL_MODEL = 'gpt-6-luna'
export const DEFAULT_MAIL_REASONING_EFFORT = 'medium'
export const DEFAULT_MAIL_MAX_INPUT_CHARS = 12_000
export const DEFAULT_MAIL_MAX_OUTPUT_TOKENS = 2_000
export const DEFAULT_MAIL_REQUEST_TIMEOUT_MS = 90_000
/** Delay between Gmail API calls; avoids per-minute query/units quota bursts during backfill. */
export const DEFAULT_GMAIL_REQUEST_DELAY_MS = 350

export const DEFAULT_AGENT_REASONING_EFFORT = 'medium'
export const DEFAULT_AGENT_MAX_STEPS = 25
export const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = 4_000
export const DEFAULT_AGENT_STEP_TIMEOUT_MS = 90_000
/**
 * `rules` (default) tries the model-free fast path before the model loop (D056, D058); `llm`
 * runs the model loop alone.
 */
export const DEFAULT_AGENT_STEP_POLICY = 'rules'
/** Loopback only: the browser container publishes CDP on host 127.0.0.1:9222 (D041). */
export const DEFAULT_BROWSER_CDP_URL = 'http://127.0.0.1:9222'
export const DEFAULT_BROWSER_HANDOFF_TIMEOUT_MINUTES = 15
export const DEFAULT_BROWSER_APPROVAL_TIMEOUT_MINUTES = 30

// Real env vars are NOT overridden by the file, so CI / vitest / production env always win.
function loadDotEnvFile(): void {
  try {
    process.loadEnvFile()
  } catch {
    // No .env file — rely on real env vars only.
  }
}

const optionalString = (schema: z.ZodString) =>
  z.preprocess((v) => (v === '' || v == null ? undefined : v), schema.optional())

const optionalInteger = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' || v == null ? undefined : v), schema.optional())

const envBoolean = (defaultValue: 'true' | 'false') =>
  z
    .preprocess(
      (v) => (v === '' || v == null ? undefined : v),
      z.enum(['true', 'false']).default(defaultValue),
    )
    .transform((value) => value === 'true')

const integerWithDefault = (min: number, max: number, defaultValue: number) =>
  z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.coerce.number().int().min(min).max(max).default(defaultValue),
  )

const envSchema = z.object({
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().startsWith('postgres://'),
  TEST_DATABASE_URL: optionalString(z.string().startsWith('postgres://')),

  OPENAI_API_KEY: optionalString(z.string().min(1)),

  // Worker-only integration secrets are optional here so the API can boot without them;
  // requireWorkerConfig() enforces them for the worker process.
  TELEGRAM_BOT_TOKEN: optionalString(
    z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'must look like <bot_id>:<bot_token>'),
  ),
  TELEGRAM_CHAT_ID: optionalInteger(z.coerce.number().int()),
  TOKEN_ENCRYPTION_KEYS: optionalString(z.string().min(1)),
  TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: optionalInteger(
    z.coerce.number().int().min(1).max(MAX_KEY_VERSION),
  ),

  // Optional cron override; semantics are validated by pg-boss, not Zod.
  HEARTBEAT_CRON: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.string().trim().min(1).default(DEFAULT_HEARTBEAT_CRON),
  ),

  // Optional bearer token enabling the detailed health view. Never logged.
  HEALTH_DETAILS_TOKEN: optionalString(z.string().min(16)),

  GMAIL_CLIENT_ID: optionalString(z.string().min(1)),
  GMAIL_CLIENT_SECRET: optionalString(z.string().min(1)),

  // Mail processing is optional so the worker can keep running heartbeat-only. When enabled,
  // requireWorkerConfig() requires Gmail OAuth + OpenAI credentials.
  MAIL_ENABLED: envBoolean('false'),
  MAIL_MODEL: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.string().trim().min(1).default(DEFAULT_MAIL_MODEL),
  ),
  MAIL_REASONING_EFFORT: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.enum(['medium', 'high']).default(DEFAULT_MAIL_REASONING_EFFORT),
  ),
  // The static classifier policy alone is ~2.5k characters; keep room for metadata and body.
  MAIL_MAX_INPUT_CHARS: integerWithDefault(4_000, 100_000, DEFAULT_MAIL_MAX_INPUT_CHARS),
  MAIL_MAX_OUTPUT_TOKENS: integerWithDefault(1, 16_000, DEFAULT_MAIL_MAX_OUTPUT_TOKENS),
  MAIL_REQUEST_TIMEOUT_MS: integerWithDefault(1_000, 300_000, DEFAULT_MAIL_REQUEST_TIMEOUT_MS),
  GMAIL_REQUEST_DELAY_MS: integerWithDefault(0, 5_000, DEFAULT_GMAIL_REQUEST_DELAY_MS),

  // Browser agent (phase 05). Optional here; requireWorkerConfig() enforces the rest when
  // AGENT_ENABLED=true. AGENT_MODEL and AGENT_TASK_MAX_USD have no defaults: they are chosen
  // from measured reliability and cost, and the model must have a pricing snapshot.
  AGENT_ENABLED: envBoolean('false'),
  AGENT_MODEL: optionalString(z.string().trim().min(1)),
  AGENT_REASONING_EFFORT: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.enum(['medium', 'high']).default(DEFAULT_AGENT_REASONING_EFFORT),
  ),
  AGENT_MAX_STEPS: integerWithDefault(1, 100, DEFAULT_AGENT_MAX_STEPS),
  AGENT_MAX_OUTPUT_TOKENS: integerWithDefault(1, 16_000, DEFAULT_AGENT_MAX_OUTPUT_TOKENS),
  AGENT_STEP_TIMEOUT_MS: integerWithDefault(1_000, 300_000, DEFAULT_AGENT_STEP_TIMEOUT_MS),
  AGENT_STEP_POLICY: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.enum(['llm', 'rules']).default(DEFAULT_AGENT_STEP_POLICY),
  ),
  AGENT_TASK_MAX_USD: optionalInteger(z.coerce.number().positive().max(10)),
  BROWSER_CDP_URL: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.string().trim().min(1).default(DEFAULT_BROWSER_CDP_URL),
  ),
  BROWSER_VIEW_URL: optionalString(z.string().trim().min(1)),
  ARTIFACT_DIR: optionalString(z.string().trim().min(1)),
  BROWSER_HANDOFF_TIMEOUT_MINUTES: integerWithDefault(
    1,
    120,
    DEFAULT_BROWSER_HANDOFF_TIMEOUT_MINUTES,
  ),
  BROWSER_APPROVAL_TIMEOUT_MINUTES: integerWithDefault(
    1,
    1_440,
    DEFAULT_BROWSER_APPROVAL_TIMEOUT_MINUTES,
  ),
})

export type Env = z.infer<typeof envSchema>

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvironmentError'
  }
}

/**
 * Pure env parser. Does not read `.env` or exit the process, so it is safe to test with fixtures.
 * Throws EnvironmentError with the prettified Zod issues.
 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    throw new EnvironmentError(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

/**
 * Load `.env` (without overriding real env), then parse. Invalid base config is fatal:
 * print the formatted error and exit 1 before any subsystem starts.
 */
export function loadEnv(): Env {
  loadDotEnvFile()
  try {
    return parseEnv(process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export const env = loadEnv()
