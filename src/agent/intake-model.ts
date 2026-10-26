import type { LanguageModelV4 } from '@ai-sdk/provider'
import { generateText, Output } from 'ai'
import type { AgentConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { createBudgetedModel } from '../llm/budgeted-model.js'
import { agentProviderOptions, createAgentProviderModel } from '../llm/openai.js'
import { buildIntakePrompt, INTAKE_INSTRUCTIONS, intakeOutputSchema } from './intake-prompt.js'

/** One non-streaming, budgeted structured call; SDK failures are sanitized by the caller. */
export async function parseIntakeWithModel(options: {
  db: Db
  runId: string
  agent: AgentConfig
  text: string
  signal?: AbortSignal
  model?: LanguageModelV4
}) {
  const { agent } = options
  const model = createBudgetedModel(options.model ?? createAgentProviderModel(agent), {
    db: options.db,
    runId: options.runId,
    purpose: 'agent_intake',
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    maxOutputTokens: agent.maxOutputTokens,
    taskMaxUsd: agent.taskMaxUsd,
  })
  const result = await generateText({
    model,
    system: INTAKE_INSTRUCTIONS,
    prompt: buildIntakePrompt(options.text),
    output: Output.object({ schema: intakeOutputSchema }),
    maxRetries: 0,
    maxOutputTokens: agent.maxOutputTokens,
    providerOptions: agentProviderOptions(agent),
    timeout: agent.stepTimeoutMs,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  })
  return result.output
}
