import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { AgentConfig } from '../config.js'

/**
 * The raw OpenAI Responses model for the agent. Always wrap it with `createBudgetedModel`;
 * callers pass `agentProviderOptions` so nothing is stored provider-side.
 */
export function createAgentProviderModel(
  config: Pick<AgentConfig, 'openaiApiKey' | 'model'>,
): LanguageModelV4 {
  return createOpenAI({ apiKey: config.openaiApiKey }).responses(config.model)
}

export function agentProviderOptions(config: Pick<AgentConfig, 'reasoningEffort'>) {
  return { openai: { store: false, reasoningEffort: config.reasoningEffort } }
}

/**
 * Abort signal for one agent run: worker shutdown or task cancellation, whichever comes first.
 * The browser agent bounds each model request separately; human and approval waits use
 * their own deadlines (D049).
 */
export function agentRunSignal(signals: {
  shutdown?: AbortSignal
  taskCancel?: AbortSignal
}): AbortSignal | undefined {
  const list = [
    ...(signals.shutdown !== undefined ? [signals.shutdown] : []),
    ...(signals.taskCancel !== undefined ? [signals.taskCancel] : []),
  ]
  return list.length > 0 ? AbortSignal.any(list) : undefined
}
