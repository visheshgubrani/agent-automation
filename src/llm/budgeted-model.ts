import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider'
import { type LanguageModelMiddleware, wrapLanguageModel } from 'ai'
import { type LlmCallUsage, type ReasoningEffort, withLlmCall } from '../audit/calls.js'
import type { Db } from '../db/index.js'
import { getLlmBudgetUsageForRange, getLlmBudgetUsageForRun } from '../db/queries/audit.js'
import type { Logger } from '../logger.js'
import { AGENT_PURPOSE_PREFIX, getBudgetSettings, localDayRange } from './budget.js'
import { classifyAiSdkError } from './errors.js'
import { computeUsageCostUsd, estimateReservationUsd, getModelRates } from './pricing.js'
import { withSerializedModelCall } from './serial.js'

/** Extra input allowance for role markers, tool framing, and provider-side formatting. */
export const AGENT_INPUT_TOKEN_OVERHEAD = 1_024

const BUDGET_EPSILON = 1e-9

export type BudgetRefusalReason =
  | 'max_output_tokens_required'
  | 'max_output_tokens_exceeded'
  | 'streaming_not_supported'
  | 'non_text_prompt'
  | 'task_cap'
  | 'daily_limit'
  | 'agent_limit'

/**
 * The call was refused before any reservation or provider request. `task_cap`,
 * `daily_limit`, and `agent_limit` end the task with `budget_exhausted`.
 */
export class ModelBudgetRefusedError extends Error {
  readonly reason: BudgetRefusalReason

  constructor(reason: BudgetRefusalReason, message: string) {
    super(message)
    this.name = 'ModelBudgetRefusedError'
    this.reason = reason
  }
}

export function isBudgetExhausted(error: unknown): boolean {
  return (
    error instanceof ModelBudgetRefusedError &&
    (error.reason === 'task_cap' ||
      error.reason === 'daily_limit' ||
      error.reason === 'agent_limit')
  )
}

export interface BudgetedModelOptions {
  db: Db
  log?: Logger
  /** The run every call is recorded under; the task cap also counts additionalRunIds. */
  runId: string
  /** Earlier model runs belonging to this task (for example its pinned intake parse). */
  additionalRunIds?: readonly string[]
  /** Must start with `agent_` so the agent sub-limit counts it. */
  purpose: string
  /** Priced model id (`AGENT_MODEL`). */
  model: string
  reasoningEffort?: ReasoningEffort
  /** Upper bound for `maxOutputTokens`; every call must set a value at or below it. */
  maxOutputTokens: number
  /** Per-task model-spend cap in USD. */
  taskMaxUsd: number
  now?: () => Date
}

/** Character count of the prompt and tool schemas; the reservation prices 2 tokens per char. */
export function promptCharCount(params: LanguageModelV4CallOptions): number {
  let chars = 0
  for (const message of params.prompt) {
    if (typeof message.content === 'string') {
      chars += message.content.length
      continue
    }
    for (const part of message.content) {
      if (part.type === 'file') {
        throw new ModelBudgetRefusedError('non_text_prompt', 'the agent is text-only')
      }
      chars += JSON.stringify(part).length
    }
  }
  if (params.tools !== undefined) chars += JSON.stringify(params.tools).length
  if (params.responseFormat !== undefined) chars += JSON.stringify(params.responseFormat).length
  return chars
}

function toCallUsage(
  usage: LanguageModelV4Usage,
  model: string,
  reservationUsd: number,
  providerRequestId: string | undefined,
): LlmCallUsage {
  const input = usage.inputTokens.total
  const output = usage.outputTokens.total
  const requestId = providerRequestId !== undefined ? { providerRequestId } : {}
  if (input === undefined || output === undefined) {
    // Missing usage: record the reservation as the cost so spend is never under-counted.
    return { costUsd: reservationUsd, ...requestId }
  }
  const tokens = {
    inputTokens: input,
    cachedInputTokens: usage.inputTokens.cacheRead ?? 0,
    cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0,
    outputTokens: output,
    reasoningTokens: usage.outputTokens.reasoning ?? 0,
  }
  return {
    promptTokens: tokens.inputTokens,
    cachedInputTokens: tokens.cachedInputTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    completionTokens: tokens.outputTokens,
    reasoningTokens: tokens.reasoningTokens,
    costUsd: computeUsageCostUsd(getModelRates(model), tokens),
    ...requestId,
  }
}

/**
 * Middleware that turns every provider attempt into a reserved, audited `llm_calls` row
 * (D044). Admission and the call run inside the process-wide FIFO model-call section shared
 * with the mail classifier, so two reservations can never pass the same remaining budget.
 */
export function budgetMiddleware(options: BudgetedModelOptions): LanguageModelMiddleware {
  if (!options.purpose.startsWith(AGENT_PURPOSE_PREFIX)) {
    throw new Error(`agent model purpose must start with "${AGENT_PURPOSE_PREFIX}"`)
  }
  const rates = getModelRates(options.model)

  return {
    specificationVersion: 'v4',
    wrapStream: async () => {
      throw new ModelBudgetRefusedError(
        'streaming_not_supported',
        'streaming is not supported by the budgeted agent model',
      )
    },
    wrapGenerate: async ({ doGenerate, params }): Promise<LanguageModelV4GenerateResult> => {
      const maxOutputTokens = params.maxOutputTokens
      if (maxOutputTokens === undefined) {
        throw new ModelBudgetRefusedError(
          'max_output_tokens_required',
          'agent model calls must set maxOutputTokens',
        )
      }
      if (maxOutputTokens > options.maxOutputTokens) {
        throw new ModelBudgetRefusedError(
          'max_output_tokens_exceeded',
          `maxOutputTokens ${maxOutputTokens} exceeds the configured ${options.maxOutputTokens}`,
        )
      }

      const reservationUsd = estimateReservationUsd(rates, {
        inputChars: promptCharCount(params),
        overheadTokens: AGENT_INPUT_TOKEN_OVERHEAD,
        maxOutputTokens,
      })

      return withSerializedModelCall(async () => {
        let taskUsd = 0
        for (const runId of new Set([options.runId, ...(options.additionalRunIds ?? [])])) {
          taskUsd += await getLlmBudgetUsageForRun(options.db, runId)
        }
        if (taskUsd + reservationUsd > options.taskMaxUsd + BUDGET_EPSILON) {
          throw new ModelBudgetRefusedError(
            'task_cap',
            `task model spend $${taskUsd.toFixed(4)} + reservation $${reservationUsd.toFixed(4)} ` +
              `exceeds the $${options.taskMaxUsd.toFixed(2)} task cap`,
          )
        }

        const settings = await getBudgetSettings(options.db)
        const range = localDayRange(options.now?.() ?? new Date(), settings.timezone)
        if (settings.dailyLimitUsd !== null) {
          const usage = await getLlmBudgetUsageForRange(options.db, range.start, range.end)
          if (usage.totalUsd + reservationUsd > settings.dailyLimitUsd + BUDGET_EPSILON) {
            throw new ModelBudgetRefusedError(
              'daily_limit',
              `daily model budget for ${range.dayKey} is used up`,
            )
          }
        }
        if (settings.agentDailyLimitUsd !== null) {
          const usage = await getLlmBudgetUsageForRange(options.db, range.start, range.end, {
            purposePrefix: AGENT_PURPOSE_PREFIX,
          })
          if (usage.totalUsd + reservationUsd > settings.agentDailyLimitUsd + BUDGET_EPSILON) {
            throw new ModelBudgetRefusedError(
              'agent_limit',
              `agent model budget for ${range.dayKey} is used up`,
            )
          }
        }

        return withLlmCall(
          {
            db: options.db,
            ...(options.log !== undefined ? { log: options.log } : {}),
            runId: options.runId,
            purpose: options.purpose,
            model: options.model,
            ...(options.reasoningEffort !== undefined
              ? { reasoningEffort: options.reasoningEffort }
              : {}),
            reservedCostUsd: reservationUsd,
          },
          async () => {
            let result: LanguageModelV4GenerateResult
            try {
              result = await doGenerate()
            } catch (error) {
              throw classifyAiSdkError(error)
            }
            return {
              result,
              usage: toCallUsage(result.usage, options.model, reservationUsd, result.response?.id),
            }
          },
        )
      })
    },
  }
}

/** Wrap a provider model so every attempt is budgeted and audited. */
export function createBudgetedModel(
  model: LanguageModelV4,
  options: BudgetedModelOptions,
): LanguageModelV4 {
  return wrapLanguageModel({ model, middleware: budgetMiddleware(options) })
}
