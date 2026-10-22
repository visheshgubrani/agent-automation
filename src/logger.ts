import pino from 'pino'
import { env } from './env.js'

export type Logger = pino.Logger

const REDACT_KEYS = [
  'token',
  'botToken',
  'authorization',
  'password',
  'key',
  'keys',
  'ciphertext',
  'nonce',
  'authTag',
  'healthToken',
  'openaiApiKey',
  'clientSecret',
  // Defense in depth if an env object is ever logged.
  'TELEGRAM_BOT_TOKEN',
  'TOKEN_ENCRYPTION_KEYS',
  'HEALTH_DETAILS_TOKEN',
  'OPENAI_API_KEY',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
] as const

// Cover top-level and nested fields without listing every possible log shape.
const REDACT_PATHS = REDACT_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`])

export interface CreateLoggerOptions {
  level: string
  /** pino-pretty for local development only; JSON everywhere else. */
  pretty: boolean
  /** Optional destination for tests or custom sinks. */
  destination?: pino.DestinationStream
}

export function createLogger({ level, pretty, destination }: CreateLoggerOptions): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: 'agent-automation', env: env.NODE_ENV },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  }

  if (destination) {
    return pino(options, destination)
  }

  if (!pretty) {
    return pino(options)
  }

  return pino({
    ...options,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
    },
  })
}

export const logger = createLogger({
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
})
