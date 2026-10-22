/**
 * Snapshot of the agreed model rates in USD per million tokens. Costs are computed and stored
 * on each `llm_calls` row at call time, so later provider price changes do not rewrite history.
 */
export interface ModelTokenRates {
  inputPerMillionUsd: number
  cachedInputPerMillionUsd: number
  cacheWritePerMillionUsd: number
  outputPerMillionUsd: number
}

export interface TokenUsage {
  /** Total input tokens, including cached and cache-write tokens. */
  inputTokens: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  /** Total output tokens, including reasoning tokens. */
  outputTokens: number
  /** Diagnostic breakdown only; already included in outputTokens. */
  reasoningTokens?: number
}

const MAIL_MODEL_RATES: Record<string, ModelTokenRates> = {
  'gpt-6-luna': {
    inputPerMillionUsd: 0.1,
    cachedInputPerMillionUsd: 0.01,
    cacheWritePerMillionUsd: 0.125,
    outputPerMillionUsd: 0.5,
  },
}

export class UnknownMailModelError extends Error {
  readonly model: string

  constructor(model: string) {
    super(`no pricing snapshot is configured for mail model "${model}"`)
    this.name = 'UnknownMailModelError'
    this.model = model
  }
}

export function isSupportedMailModel(model: string): boolean {
  return Object.hasOwn(MAIL_MODEL_RATES, model)
}

/** Rates for one model; an unknown model fails closed instead of running unpriced. */
export function getModelRates(model: string): ModelTokenRates {
  const rates = MAIL_MODEL_RATES[model]
  if (!rates) throw new UnknownMailModelError(model)
  return rates
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(0, value) : 0
}

/**
 * Cost from one response's usage. `input_tokens` includes cached and cache-write tokens, and
 * `output_tokens` includes reasoning tokens; both details are priced by their own rate but never
 * added again on top of the totals.
 */
export function computeUsageCostUsd(rates: ModelTokenRates, usage: TokenUsage): number {
  const input = nonNegative(usage.inputTokens)
  const cached = Math.min(input, nonNegative(usage.cachedInputTokens))
  const cacheWrite = Math.min(input - cached, nonNegative(usage.cacheWriteTokens))
  const uncached = Math.max(0, input - cached - cacheWrite)
  const output = nonNegative(usage.outputTokens)

  const cost =
    (uncached * rates.inputPerMillionUsd +
      cached * rates.cachedInputPerMillionUsd +
      cacheWrite * rates.cacheWritePerMillionUsd +
      output * rates.outputPerMillionUsd) /
    1_000_000

  return Math.round(cost * 1_000_000) / 1_000_000
}

/** Extra input allowance for role markers and provider-side formatting. */
export const CLASSIFIER_INPUT_TOKEN_OVERHEAD = 512

/**
 * Bounded worst-case reservation for one classifier attempt. The prompt builder caps total
 * prompt characters at `maxInputChars`; two tokens per character is deliberately conservative
 * for unusual Unicode. `maxOutputTokens` already includes any reasoning tokens.
 */
export function estimateClassifierReservationUsd(
  rates: ModelTokenRates,
  options: { maxInputChars: number; maxOutputTokens: number },
): number {
  const inputTokens = Math.max(0, options.maxInputChars) * 2 + CLASSIFIER_INPUT_TOKEN_OVERHEAD
  const outputTokens = Math.max(0, options.maxOutputTokens)
  const cost =
    (inputTokens * rates.inputPerMillionUsd + outputTokens * rates.outputPerMillionUsd) / 1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}
