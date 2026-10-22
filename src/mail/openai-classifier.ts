import OpenAI, { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import type { LlmCallUsage } from '../audit/calls.js'
import type { MailConfig } from '../config.js'
import {
  ClassifierInputTooLargeError,
  ClassifierInvalidOutputError,
  ClassifierRefusalError,
  ClassifierUncertainError,
} from './classifier-errors.js'
import {
  type ClassifierOutput,
  ClassifierOutputSchema,
  normalizeClassifierOutput,
} from './classifier-prompt.js'
import { computeUsageCostUsd, getModelRates } from './pricing.js'

export interface MailClassifierCall {
  instructions: string
  input: string
  signal?: AbortSignal
}

export interface MailClassifierResult {
  output: ClassifierOutput
  usage: LlmCallUsage
}

export type MailClassifier = (call: MailClassifierCall) => Promise<MailClassifierResult>

interface OpenAiUsage {
  input_tokens: number
  input_tokens_details?: {
    cached_tokens?: number | null
    cache_write_tokens?: number | null
  } | null
  output_tokens: number
  output_tokens_details?: { reasoning_tokens?: number | null } | null
}

/** Map provider usage into audit fields and snapshot the cost at today's configured rates. */
export function usageFromResponse(
  model: string,
  response: { id?: string | null; usage?: OpenAiUsage | null },
): LlmCallUsage | undefined {
  const usage = response.usage
  if (!usage) return undefined

  const promptTokens = Math.max(0, usage.input_tokens)
  const cachedInputTokens = Math.min(
    promptTokens,
    Math.max(0, usage.input_tokens_details?.cached_tokens ?? 0),
  )
  const cacheWriteTokens = Math.min(
    promptTokens - cachedInputTokens,
    Math.max(0, usage.input_tokens_details?.cache_write_tokens ?? 0),
  )
  const completionTokens = Math.max(0, usage.output_tokens)
  const reasoningTokens = Math.min(
    completionTokens,
    Math.max(0, usage.output_tokens_details?.reasoning_tokens ?? 0),
  )

  const costUsd = computeUsageCostUsd(getModelRates(model), {
    inputTokens: promptTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: completionTokens,
    reasoningTokens,
  })

  return {
    promptTokens,
    cachedInputTokens,
    cacheWriteTokens,
    completionTokens,
    reasoningTokens,
    costUsd,
    ...(response.id ? { providerRequestId: response.id } : {}),
  }
}

function hasRefusal(response: {
  output: Array<{ type: string; content?: Array<{ type: string }> }>
}): boolean {
  for (const item of response.output) {
    if (item.type !== 'message') continue
    for (const content of item.content ?? []) {
      if (content.type === 'refusal') return true
    }
  }
  return false
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const candidate = error as { code?: unknown; cause?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return candidate.cause === undefined ? undefined : errorCode(candidate.cause)
}

/** Failures that provably happened before the request reached the provider. */
const PRE_SEND_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

/** A provider outcome that may have reached the model; the audit row should become unknown. */
export function isUncertainModelError(error: unknown): boolean {
  if (error instanceof ClassifierUncertainError) return true
  if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) return true
  if (error instanceof APIError) {
    if (error.status !== undefined) return error.status === 408 || error.status >= 500
    const code = errorCode(error)
    return code === undefined || !PRE_SEND_NETWORK_CODES.has(code)
  }
  const code = errorCode(error)
  return code === undefined || !PRE_SEND_NETWORK_CODES.has(code)
}

/** A definitive rejection; retrying the same message is not useful. */
export function isPermanentModelError(error: unknown): boolean {
  if (
    error instanceof ClassifierRefusalError ||
    error instanceof ClassifierInvalidOutputError ||
    error instanceof ClassifierInputTooLargeError
  ) {
    return true
  }
  if (error instanceof APIError) {
    if (error.status === undefined) return false
    if (error.status === 408 || error.status === 429 || error.status >= 500) return false
    return error.status >= 400 && error.status < 500
  }
  return false
}

export function providerRequestIdOf(error: unknown): string | undefined {
  return error instanceof APIError ? (error.requestID ?? undefined) : undefined
}

function invalidOutput(
  error: unknown,
  usage: LlmCallUsage | undefined,
): ClassifierInvalidOutputError {
  const message = error instanceof Error ? error.message : 'classifier output was invalid'
  return new ClassifierInvalidOutputError(message, { usage })
}

/**
 * Responses API classifier. No tools are supplied, `store` is false, and SDK retries are
 * disabled so every paid attempt is durably reserved/audited by the caller.
 */
export function createOpenAiMailClassifier(
  config: MailConfig,
  options: { client?: OpenAI } = {},
): MailClassifier {
  const client =
    options.client ??
    new OpenAI({
      apiKey: config.openaiApiKey,
      maxRetries: 0,
      timeout: config.requestTimeoutMs,
    })

  return async (call) => {
    const response = await client.responses.parse(
      {
        model: config.model,
        instructions: call.instructions,
        input: call.input,
        reasoning: { effort: config.reasoningEffort },
        max_output_tokens: config.maxOutputTokens,
        store: false,
        text: { format: zodTextFormat(ClassifierOutputSchema, 'mail_classification') },
      },
      {
        timeout: config.requestTimeoutMs,
        ...(call.signal !== undefined ? { signal: call.signal } : {}),
      },
    )

    const usage = usageFromResponse(config.model, response)
    const refusal = hasRefusal(response) || response.incomplete_details?.reason === 'content_filter'

    if (response.error) {
      throw new ClassifierUncertainError(`classifier response failed: ${response.error.code}`, {
        usage,
        cause: new Error(response.error.message),
      })
    }
    if (refusal) {
      throw new ClassifierRefusalError('classifier refused the message', { usage })
    }
    if (response.status === 'failed') {
      throw new ClassifierUncertainError('classifier response failed', { usage })
    }
    if (response.status !== 'completed') {
      throw new ClassifierInvalidOutputError(
        `classifier response was ${response.status ?? 'unknown'}`,
        { usage },
      )
    }
    if (response.output_parsed === null || response.output_parsed === undefined) {
      throw new ClassifierInvalidOutputError('classifier returned no structured output', { usage })
    }
    if (!usage) {
      throw new ClassifierUncertainError('classifier response omitted usage')
    }

    let output: ClassifierOutput
    try {
      output = normalizeClassifierOutput(response.output_parsed)
    } catch (error) {
      throw invalidOutput(error, usage)
    }

    return { output, usage }
  }
}
