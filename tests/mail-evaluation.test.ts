import { describe, expect, it } from 'vitest'
import {
  computeEvaluationMetrics,
  EVALUATION_PROMPT_EXAMPLES,
  type EvaluationCaseResult,
  formatEvaluationReport,
  HELD_OUT_EVALUATION_CASES,
  runEvaluation,
} from '../src/mail/evaluation.js'
import type { MailClassifier } from '../src/mail/openai-classifier.js'

const USAGE = {
  promptTokens: 100,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  completionTokens: 10,
  reasoningTokens: 0,
  costUsd: 0.001,
  providerRequestId: 'eval-fake',
}

function fakeClassifier(
  behavior: (input: string, subject: string) => boolean | Promise<boolean>,
): MailClassifier {
  return async ({ input }) => {
    const testCase = HELD_OUT_EVALUATION_CASES.find((candidate) =>
      input.includes(candidate.subject),
    )
    const shouldNotify = testCase ? await behavior(input, testCase.subject) : false
    return {
      output: {
        topic: 'other',
        category: 'fyi',
        shouldNotify,
        confidence: 0.9,
        summary: 'Synthetic evaluation result',
        reason: 'Synthetic evaluation reason',
      },
      usage: USAGE,
    }
  }
}

describe('evaluation dataset', () => {
  it('keeps prompt examples disjoint from held-out cases and covers both labels', () => {
    const promptIds = new Set(EVALUATION_PROMPT_EXAMPLES.map((example) => example.messageId))
    const caseIds = new Set(HELD_OUT_EVALUATION_CASES.map((testCase) => testCase.id))
    expect([...promptIds].some((id) => caseIds.has(id))).toBe(false)

    const promptSubjects = new Set(EVALUATION_PROMPT_EXAMPLES.map((example) => example.subject))
    expect(HELD_OUT_EVALUATION_CASES.some((testCase) => promptSubjects.has(testCase.subject))).toBe(
      false,
    )

    expect(HELD_OUT_EVALUATION_CASES.length).toBeGreaterThanOrEqual(12)
    expect(HELD_OUT_EVALUATION_CASES.some((testCase) => testCase.expectedShouldNotify)).toBe(true)
    expect(HELD_OUT_EVALUATION_CASES.some((testCase) => !testCase.expectedShouldNotify)).toBe(true)
    expect(EVALUATION_PROMPT_EXAMPLES).toHaveLength(6)
  })
})

describe('evaluation metrics', () => {
  it('computes recall/precision, cost, latency, and errors', () => {
    const results: EvaluationCaseResult[] = [
      {
        id: 'a',
        description: 'a',
        expected: true,
        actual: true,
        correct: true,
        topic: null,
        category: null,
        confidence: null,
        latencyMs: 100,
        costUsd: 0.01,
      },
      {
        id: 'b',
        description: 'b',
        expected: true,
        actual: true,
        correct: true,
        topic: null,
        category: null,
        confidence: null,
        latencyMs: 200,
        costUsd: 0.01,
      },
      {
        id: 'c',
        description: 'c',
        expected: true,
        actual: true,
        correct: true,
        topic: null,
        category: null,
        confidence: null,
        latencyMs: 300,
        costUsd: 0.01,
      },
      {
        id: 'd',
        description: 'd',
        expected: true,
        actual: false,
        correct: false,
        topic: null,
        category: null,
        confidence: null,
        latencyMs: 400,
        costUsd: 0.01,
      },
      {
        id: 'e',
        description: 'e',
        expected: false,
        actual: true,
        correct: false,
        topic: null,
        category: null,
        confidence: null,
        latencyMs: 500,
        costUsd: 0.01,
      },
      {
        id: 'f',
        description: 'f',
        expected: false,
        actual: false,
        correct: true,
        topic: null,
        category: null,
        confidence: null,
        latencyMs: 600,
        costUsd: 0.01,
      },
      {
        id: 'g',
        description: 'g',
        expected: false,
        actual: false,
        correct: true,
        topic: null,
        category: null,
        confidence: null,
        latencyMs: 700,
        costUsd: 0.01,
      },
      {
        id: 'h',
        description: 'h',
        expected: true,
        actual: null,
        correct: false,
        topic: null,
        category: null,
        confidence: null,
        latencyMs: 800,
        costUsd: 0,
        error: 'failure',
      },
    ]

    expect(computeEvaluationMetrics(results)).toEqual({
      cases: 8,
      truePositives: 3,
      falsePositives: 1,
      trueNegatives: 2,
      falseNegatives: 1,
      errors: 1,
      recall: 0.75,
      precision: 0.75,
      totalCostUsd: 0.07,
      averageLatencyMs: 450,
    })
  })

  it('runs the scored cases with prompt examples and records cost/latency', async () => {
    const results = await runEvaluation({
      classifier: fakeClassifier(() => true),
      cases: HELD_OUT_EVALUATION_CASES.filter((testCase) => testCase.expectedShouldNotify),
    })
    expect(results).toHaveLength(9)
    expect(results.every((result) => result.actual === true)).toBe(true)
    expect(results.every((result) => result.costUsd === 0.001)).toBe(true)
    expect(results.every((result) => result.latencyMs >= 0)).toBe(true)
    const metrics = computeEvaluationMetrics(results)
    expect(metrics).toMatchObject({ recall: 1, precision: 1, errors: 0 })
  })

  it('records a failed model call as an error rather than a successful ignore', async () => {
    const cases = HELD_OUT_EVALUATION_CASES.slice(0, 2)
    const results = await runEvaluation({
      classifier: fakeClassifier((_input, subject) => {
        if (subject === cases[0]?.subject) throw new Error('provider timeout')
        return true
      }),
      cases,
    })
    expect(results[0]).toMatchObject({ actual: null, error: 'Error: provider timeout' })
    expect(computeEvaluationMetrics(results)).toMatchObject({ errors: 1 })
  })

  it('formats metrics without leaking bodies', async () => {
    const cases = HELD_OUT_EVALUATION_CASES.slice(0, 1)
    const results = await runEvaluation({
      classifier: fakeClassifier(() => false),
      cases,
    })
    const report = formatEvaluationReport('medium', results)
    expect(report).toContain('recall')
    expect(report).toContain('precision')
    expect(report).toContain('cost $')
    expect(report).toContain('avg latency')
    expect(report).not.toContain(cases[0]?.cleanText ?? 'unlikely-body')
  })
})
