import { GrammyError, HttpError } from 'grammy'

const DEFAULT_MESSAGE_LIMIT = 500
const MAX_CAUSE_DEPTH = 5

/** Safe, bounded error data for logs and audit rows. Never includes Telegram payloads or secrets. */
export interface ErrorDetails {
  name: string
  message: string
  /** Node/network error code, when present (for example ENOTFOUND or ECONNRESET). */
  code?: string
  /** Telegram API error code, when this is a GrammyError. */
  errorCode?: number
}

export type SendFailureKind = 'retryable' | 'permanent' | 'uncertain'

export interface TelegramSendFailure {
  kind: SendFailureKind
  /** Short, safe description suitable for logs and last_error. */
  reason: string
  retryAfterSeconds?: number
  code?: string
  errorCode?: number
}

// The request never reached Telegram: nothing was delivered, so retrying is safe.
const RETRYABLE_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

const ABORT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError'])

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

/** Walk an error/cause chain looking for a Node error code. */
function networkCode(error: unknown, depth = 0): string | undefined {
  if (depth > MAX_CAUSE_DEPTH || error == null || typeof error !== 'object') {
    return undefined
  }

  const candidate = error as { code?: unknown; cause?: unknown }
  if (typeof candidate.code === 'string' && candidate.code.length > 0) {
    return candidate.code
  }
  if (candidate.cause !== undefined) {
    return networkCode(candidate.cause, depth + 1)
  }
  return undefined
}

/**
 * Walk an error/cause chain (including grammy's `HttpError.error` wrapper) looking for an
 * abort-style error name. Fetch rejects with the abort reason, so a send deadline reads as
 * `TimeoutError`, while a mid-flight shutdown abort reads as `AbortError`.
 */
function abortErrorName(error: unknown, depth = 0): string | undefined {
  if (depth > MAX_CAUSE_DEPTH || error == null || typeof error !== 'object') {
    return undefined
  }

  const candidate = error as { name?: unknown; error?: unknown; cause?: unknown }
  if (typeof candidate.name === 'string' && ABORT_ERROR_NAMES.has(candidate.name)) {
    return candidate.name
  }
  for (const nested of [candidate.error, candidate.cause]) {
    if (nested !== undefined) {
      const name = abortErrorName(nested, depth + 1)
      if (name) return name
    }
  }
  return undefined
}

function isTlsConfigurationCode(code: string): boolean {
  return code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')
}

/**
 * Convert any thrown value into bounded, safe data. Raw Grammy payloads are deliberately excluded
 * because they contain chat ids and message text.
 */
export function errorDetails(
  error: unknown,
  maxMessageLength = DEFAULT_MESSAGE_LIMIT,
): ErrorDetails {
  if (error instanceof GrammyError) {
    return {
      name: 'GrammyError',
      message: truncate(error.description || error.message, maxMessageLength),
      errorCode: error.error_code,
    }
  }

  if (error instanceof HttpError) {
    const code = networkCode(error.error) ?? networkCode(error)
    return {
      name: 'HttpError',
      message: truncate(error.message || 'Telegram HTTP request failed', maxMessageLength),
      ...(code ? { code } : {}),
    }
  }

  if (error instanceof Error) {
    const code = networkCode(error)
    return {
      name: error.name || 'Error',
      message: truncate(error.message || 'Unknown error', maxMessageLength),
      ...(code ? { code } : {}),
    }
  }

  if (typeof error === 'string') {
    return { name: 'Error', message: truncate(error, maxMessageLength) }
  }

  return { name: 'UnknownError', message: 'Non-Error value thrown' }
}

/** One-line, bounded error string for runs.last_error / notification_outbox.last_error. */
export function errorMessage(error: unknown, maxLength = 1000): string {
  const details = errorDetails(error, Math.max(0, maxLength - 48))
  const suffix =
    details.errorCode !== undefined
      ? ` [${details.errorCode}]`
      : details.code
        ? ` [${details.code}]`
        : ''
  return truncate(`${details.name}: ${details.message}${suffix}`, maxLength)
}

/**
 * Classify a Telegram send failure for the dispatcher.
 *
 * - retryable: the request provably never reached Telegram (429, DNS, refused/unreachable)
 * - permanent: a definitive API/config rejection (other 4xx, TLS configuration)
 * - uncertain: delivery may or may not have happened (timeout/abort, reset mid-flight, 5xx, unknown)
 *
 * Callers apply the outbox row's delivery policy to uncertain failures: quarantine for
 * at-most-once, retry for at-least-once.
 */
export function classifyTelegramSendError(error: unknown): TelegramSendFailure {
  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      const retryAfter = error.parameters.retry_after
      return {
        kind: 'retryable',
        reason: 'telegram 429 rate limited',
        errorCode: 429,
        ...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {}),
      }
    }

    if (error.error_code >= 400 && error.error_code < 500) {
      return {
        kind: 'permanent',
        reason: `telegram ${error.error_code}`,
        errorCode: error.error_code,
      }
    }

    return {
      kind: 'uncertain',
      reason: `telegram ${error.error_code}`,
      errorCode: error.error_code,
    }
  }

  const code =
    error instanceof HttpError
      ? (networkCode(error.error) ?? networkCode(error))
      : networkCode(error)

  if (code) {
    if (RETRYABLE_NETWORK_CODES.has(code)) {
      return { kind: 'retryable', reason: `network ${code}`, code }
    }
    if (isTlsConfigurationCode(code)) {
      return { kind: 'permanent', reason: `tls ${code}`, code }
    }
    return { kind: 'uncertain', reason: `network ${code}`, code }
  }

  // Direct AbortError/TimeoutError, or one wrapped by grammy's HttpError after a fetch abort
  // (send deadline or shutdown mid-flight). Delivery may have happened: uncertain.
  const abortName = abortErrorName(error)
  if (abortName) {
    return { kind: 'uncertain', reason: abortName === 'TimeoutError' ? 'timeout' : 'aborted' }
  }

  return { kind: 'uncertain', reason: 'unknown send error' }
}
