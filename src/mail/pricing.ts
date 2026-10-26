import { estimateReservationUsd, type ModelTokenRates } from '../llm/pricing.js'

// Generic pricing moved to src/llm/ in phase 05; mail callers keep their original names.
export {
  computeUsageCostUsd,
  getModelRates,
  isSupportedModel as isSupportedMailModel,
  type ModelTokenRates,
  type TokenUsage,
  UnknownModelError as UnknownMailModelError,
} from '../llm/pricing.js'

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
  return estimateReservationUsd(rates, {
    inputChars: options.maxInputChars,
    overheadTokens: CLASSIFIER_INPUT_TOKEN_OVERHEAD,
    maxOutputTokens: options.maxOutputTokens,
  })
}
