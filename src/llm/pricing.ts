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

/**
 * Every model the app may call, mail classifier and agent alike. A model must be listed here
 * before it can be configured (`MAIL_MODEL`, `AGENT_MODEL`); unknown models fail closed.
 */
const MODEL_RATES: Record<string, ModelTokenRates> = {
  'gpt-6-luna': {
    inputPerMillionUsd: 0.1,
    cachedInputPerMillionUsd: 0.01,
    cacheWritePerMillionUsd: 0.125,
    outputPerMillionUsd: 0.5,
  },
}

export class UnknownModelError extends Error {
  readonly model: string

  constructor(model: string) {
    super(`no pricing snapshot is configured for model "${model}"`)
    this.name = 'UnknownModelError'
    this.model = model
  }
}

export function isSupportedModel(model: string): boolean {
  return Object.hasOwn(MODEL_RATES, model)
}

/** Rates for one model; an unknown model fails closed instead of running unpriced. */
export function getModelRates(model: string): ModelTokenRates {
  const rates = MODEL_RATES[model]
  if (!rates) throw new UnknownModelError(model)
  return rates
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(0, value) : 0
}

function roundUsd(cost: number): number {
  return Math.round(cost * 1_000_000) / 1_000_000
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

  return roundUsd(
    (uncached * rates.inputPerMillionUsd +
      cached * rates.cachedInputPerMillionUsd +
      cacheWrite * rates.cacheWritePerMillionUsd +
      output * rates.outputPerMillionUsd) /
      1_000_000,
  )
}

/**
 * Bounded worst-case reservation for one model attempt. Two tokens per input character is
 * deliberately conservative for unusual Unicode; `overheadTokens` covers role markers and
 * provider-side formatting. `maxOutputTokens` already includes any reasoning tokens. Every
 * input token is priced at the uncached rate, which is never lower than the cached rates.
 */
export function estimateReservationUsd(
  rates: ModelTokenRates,
  options: { inputChars: number; overheadTokens: number; maxOutputTokens: number },
): number {
  const inputTokens = Math.max(0, options.inputChars) * 2 + Math.max(0, options.overheadTokens)
  const outputTokens = Math.max(0, options.maxOutputTokens)
  return roundUsd(
    (inputTokens * rates.inputPerMillionUsd + outputTokens * rates.outputPerMillionUsd) / 1_000_000,
  )
}
