import { APICallError } from '@ai-sdk/provider'
import {
  LlmCallFailedError,
  LlmCallOutcomeUnknownError,
  type LlmCallUsage,
} from '../audit/calls.js'

/** Failures that provably happened before the request reached the provider. */
const PRE_SEND_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

function errorCode(error: unknown, depth = 0): string | undefined {
  if (error === null || typeof error !== 'object' || depth > 4) return undefined
  const candidate = error as { code?: unknown; cause?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return errorCode(candidate.cause, depth + 1)
}

function isAbortOrTimeout(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object' || depth > 4) return false
  const { name, cause } = error as { name?: unknown; cause?: unknown }
  if (name === 'AbortError' || name === 'TimeoutError') return true
  return isAbortOrTimeout(cause, depth + 1)
}

function requestIdOf(error: APICallError): string | undefined {
  const headers = error.responseHeaders ?? {}
  return headers['x-request-id'] ?? headers['openai-request-id'] ?? undefined
}

/**
 * Map an AI SDK provider error for `withLlmCall` (same policy as the mail classifier):
 *
 * - abort/timeout, 408, 5xx, an unknown network failure, or anything unrecognized → the request
 *   may have reached the model: `LlmCallOutcomeUnknownError` (reservation stays counted);
 * - a definitive 4xx (including 429) or a provable pre-send network failure → `LlmCallFailedError`.
 *
 * The provider request id is kept when present. Already-classified audit errors pass through.
 */
export function classifyAiSdkError(
  error: unknown,
): LlmCallFailedError | LlmCallOutcomeUnknownError {
  if (error instanceof LlmCallFailedError || error instanceof LlmCallOutcomeUnknownError) {
    return error
  }

  // Provider errors can echo prompt/response text. Persist only fixed classifications,
  // HTTP status and request id; keep the cause in memory for internal classification.
  if (isAbortOrTimeout(error)) {
    return new LlmCallOutcomeUnknownError(`agent model call aborted or timed out`, {
      cause: error,
    })
  }

  if (APICallError.isInstance(error)) {
    const requestId = requestIdOf(error)
    const usage: LlmCallUsage | undefined =
      requestId !== undefined ? { providerRequestId: requestId } : undefined
    const options = { cause: error, ...(usage !== undefined ? { usage } : {}) }
    const status = error.statusCode
    if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
      return new LlmCallFailedError(`agent model call rejected (${status})`, options)
    }
    if (status === undefined) {
      const code = errorCode(error)
      if (code !== undefined && PRE_SEND_NETWORK_CODES.has(code)) {
        return new LlmCallFailedError(`agent model request was not sent`, options)
      }
    }
    return new LlmCallOutcomeUnknownError(`agent model outcome is unknown`, options)
  }

  const code = errorCode(error)
  if (code !== undefined && PRE_SEND_NETWORK_CODES.has(code)) {
    return new LlmCallFailedError(`agent model request was not sent`, { cause: error })
  }
  return new LlmCallOutcomeUnknownError(`agent model outcome is unknown`, { cause: error })
}
