import type OpenAI from 'openai'
import { APIError } from 'openai'
import { describe, expect, it, vi } from 'vitest'
import type { MailConfig } from '../src/config.js'
import {
  ClassifierInvalidOutputError,
  ClassifierRefusalError,
  ClassifierUncertainError,
} from '../src/mail/classifier-errors.js'
import {
  createOpenAiMailClassifier,
  isPermanentModelError,
  isUncertainModelError,
  usageFromResponse,
} from '../src/mail/openai-classifier.js'

const config: MailConfig = {
  gmail: { clientId: 'client-id', clientSecret: 'client-secret' },
  openaiApiKey: 'sk-test',
  model: 'gpt-6-luna',
  reasoningEffort: 'medium',
  maxInputChars: 12_000,
  maxOutputTokens: 2_000,
  requestTimeoutMs: 30_000,
  gmailRequestDelayMs: 0,
}

const validOutput = {
  topic: 'banking',
  category: 'fyi',
  shouldNotify: true,
  confidence: 0.9,
  summary: 'Debit posted',
  reason: 'bank debit alert',
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_123',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output_parsed: validOutput,
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
    usage: {
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 50 },
    },
    ...overrides,
  }
}

function fakeClient(payload: unknown) {
  const parse = vi.fn(async () => payload)
  return { client: { responses: { parse } } as unknown as OpenAI, parse }
}

describe('OpenAI classifier', () => {
  it('maps response usage to a snapshotted cost without double-counting reasoning', () => {
    const usage = usageFromResponse('gpt-6-luna', response())
    expect(usage).toMatchObject({
      promptTokens: 1_000,
      cachedInputTokens: 400,
      cacheWriteTokens: 100,
      completionTokens: 200,
      reasoningTokens: 50,
      providerRequestId: 'resp_123',
    })
    expect(usage?.costUsd).toBe(0.000167)
  })

  it('calls the Responses API with structured output, effort, no tools, and no storage', async () => {
    const { client, parse } = fakeClient(response())
    const classifier = createOpenAiMailClassifier(config, { client })

    const result = await classifier({ instructions: 'classify it', input: 'untrusted email' })

    expect(result.output).toEqual(validOutput)
    expect(result.usage.providerRequestId).toBe('resp_123')
    const [params, options] = parse.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(params).toMatchObject({
      model: 'gpt-6-luna',
      instructions: 'classify it',
      input: 'untrusted email',
      reasoning: { effort: 'medium' },
      max_output_tokens: 2_000,
      store: false,
    })
    expect(params).not.toHaveProperty('tools')
    expect(options).toMatchObject({ timeout: 30_000 })
  })

  it('surfaces refusals and invalid output as typed permanent failures with usage', async () => {
    const refusalClient = fakeClient(
      response({
        output_parsed: null,
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
      }),
    ).client
    const refusal = createOpenAiMailClassifier(config, { client: refusalClient })
    await expect(refusal({ instructions: 'x', input: 'y' })).rejects.toMatchObject({
      name: 'ClassifierRefusalError',
      usage: { providerRequestId: 'resp_123' },
    })
    await expect(refusal({ instructions: 'x', input: 'y' })).rejects.toBeInstanceOf(
      ClassifierRefusalError,
    )

    const invalidClient = fakeClient(
      response({ output_parsed: { ...validOutput, topic: 'not-a-topic' } }),
    ).client
    const invalid = createOpenAiMailClassifier(config, { client: invalidClient })
    await expect(invalid({ instructions: 'x', input: 'y' })).rejects.toBeInstanceOf(
      ClassifierInvalidOutputError,
    )
  })

  it('treats provider failures and missing usage as uncertain outcomes', async () => {
    const failedClient = fakeClient(
      response({
        status: 'failed',
        error: { code: 'server_error', message: 'provider failed' },
        output_parsed: null,
      }),
    ).client
    const failed = createOpenAiMailClassifier(config, { client: failedClient })
    await expect(failed({ instructions: 'x', input: 'y' })).rejects.toBeInstanceOf(
      ClassifierUncertainError,
    )

    const missingUsageClient = fakeClient(response({ usage: null })).client
    const missingUsage = createOpenAiMailClassifier(config, { client: missingUsageClient })
    await expect(missingUsage({ instructions: 'x', input: 'y' })).rejects.toBeInstanceOf(
      ClassifierUncertainError,
    )
  })

  it('classifies API and typed errors for retry policy', () => {
    expect(isUncertainModelError(new APIError(500, undefined, 'server', new Headers()))).toBe(true)
    expect(isUncertainModelError(new APIError(429, undefined, 'rate', new Headers()))).toBe(false)
    expect(isPermanentModelError(new APIError(400, undefined, 'bad', new Headers()))).toBe(true)
    expect(isPermanentModelError(new APIError(429, undefined, 'rate', new Headers()))).toBe(false)
    expect(isPermanentModelError(new ClassifierRefusalError('no'))).toBe(true)
  })
})
