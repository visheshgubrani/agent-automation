import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'

export function usage(
  input: number,
  output: number,
  extra: Partial<{
    cacheRead: number
    cacheWrite: number
    reasoning: number
  }> = {},
): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: input,
      noCache: input - (extra.cacheRead ?? 0),
      cacheRead: extra.cacheRead,
      cacheWrite: extra.cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output - (extra.reasoning ?? 0),
      reasoning: extra.reasoning,
    },
  }
}

export const MISSING_USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

export function textResult(
  text: string,
  u: LanguageModelV4Usage = usage(100, 20),
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: u,
    response: { id: 'resp_test' },
    warnings: [],
  } as LanguageModelV4GenerateResult
}

export function toolCallResult(
  toolName: string,
  input: Record<string, unknown>,
  u: LanguageModelV4Usage = usage(100, 20),
): LanguageModelV4GenerateResult {
  const content: LanguageModelV4Content[] = [
    {
      type: 'tool-call',
      toolCallId: `call_${toolName}_${Math.random().toString(36).slice(2, 8)}`,
      toolName,
      input: JSON.stringify(input),
    },
  ]
  return {
    content,
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: u,
    response: { id: `resp_${toolName}` },
    warnings: [],
  } as LanguageModelV4GenerateResult
}

export type ScriptStep =
  | LanguageModelV4GenerateResult
  | ((params: LanguageModelV4CallOptions) => Promise<LanguageModelV4GenerateResult>)

/** A mock model that plays a fixed script, one step per call, and fails past its end. */
export function scriptedModel(steps: ScriptStep[], modelId = 'gpt-6-luna'): MockLanguageModelV4 {
  let index = 0
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async (params) => {
      const step = steps[index++]
      if (step === undefined) throw new Error('scripted model ran out of steps')
      return typeof step === 'function' ? step(params) : step
    },
  })
}

export function callParams(
  overrides: Partial<LanguageModelV4CallOptions> = {},
): LanguageModelV4CallOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxOutputTokens: 500,
    ...overrides,
  }
}
