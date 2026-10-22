import type { MailReasoningEffort } from '../config.js'
import { errorMessage } from '../errors.js'
import { buildClassifierPrompt } from './classifier-prompt.js'
import type { FeedbackExample } from './examples.js'
import type { MailClassifier } from './openai-classifier.js'

/**
 * Synthetic, non-private labeled mail used by `pnpm mail:evaluate`. Prompt examples teach the
 * classifier; held-out cases are scored and never enter the prompt. Keep the two sets disjoint.
 */
export const EVALUATION_PROMPT_EXAMPLES: readonly FeedbackExample[] = [
  {
    messageId: 'eval-prompt-bank-debit',
    fromEmail: 'alerts@bank.example',
    subject: 'Debit alert',
    excerpt: 'Your account was debited INR 1,250.00 at a merchant.',
    shouldNotify: true,
    reason: 'missed_important',
    note: 'Bank transaction alert',
    labeledAt: new Date('2026-10-01T00:00:00Z'),
  },
  {
    messageId: 'eval-prompt-bank-offer',
    fromEmail: 'offers@bank.example',
    subject: 'Pre-approved credit card offer',
    excerpt: 'Apply now for a pre-approved credit card with reward points.',
    shouldNotify: false,
    reason: 'too_noisy',
    note: 'Bank promotion',
    labeledAt: new Date('2026-10-01T00:01:00Z'),
  },
  {
    messageId: 'eval-prompt-work-request',
    fromEmail: 'manager@company.example',
    subject: 'Please review this before Friday',
    excerpt: 'Can you review the attached proposal and send comments by Friday?',
    shouldNotify: true,
    reason: 'missed_important',
    note: 'Direct manager request',
    labeledAt: new Date('2026-10-01T00:02:00Z'),
  },
  {
    messageId: 'eval-prompt-work-newsletter',
    fromEmail: 'newsletter@company.example',
    subject: 'This week at the company',
    excerpt: 'A roundup of cafeteria menus, sports results, and office photos.',
    shouldNotify: false,
    reason: 'too_noisy',
    note: 'Routine company bulk mail',
    labeledAt: new Date('2026-10-01T00:03:00Z'),
  },
  {
    messageId: 'eval-prompt-career-interview',
    fromEmail: 'recruiting@career.example',
    subject: 'Interview invitation',
    excerpt: 'We would like to schedule a 45-minute interview next week.',
    shouldNotify: true,
    reason: 'missed_important',
    note: 'Interview invitation',
    labeledAt: new Date('2026-10-01T00:04:00Z'),
  },
  {
    messageId: 'eval-prompt-career-ad',
    fromEmail: 'jobs@career.example',
    subject: 'Jobs you may like',
    excerpt: 'A generic list of job advertisements matching your profile.',
    shouldNotify: false,
    reason: 'too_noisy',
    note: 'Generic job advertisement',
    labeledAt: new Date('2026-10-01T00:05:00Z'),
  },
]

export interface EvaluationCase {
  id: string
  description: string
  expectedShouldNotify: boolean
  fromEmail: string
  fromName: string | null
  subject: string
  cleanText: string
}

export const HELD_OUT_EVALUATION_CASES: readonly EvaluationCase[] = [
  {
    id: 'held-bank-credit',
    description: 'Salary credited',
    expectedShouldNotify: true,
    fromEmail: 'alerts@bank.example',
    fromName: 'Bank Alerts',
    subject: 'Salary credited to your account',
    cleanText: 'Your salary of INR 85,000.00 was credited to account ending 4321.',
  },
  {
    id: 'held-bank-failure',
    description: 'Payment failed',
    expectedShouldNotify: true,
    fromEmail: 'alerts@bank.example',
    fromName: 'Bank Alerts',
    subject: 'Payment failed',
    cleanText: 'A payment of INR 2,499.00 could not be completed. Please retry.',
  },
  {
    id: 'held-bank-refund',
    description: 'Refund processed',
    expectedShouldNotify: true,
    fromEmail: 'alerts@bank.example',
    fromName: 'Bank Alerts',
    subject: 'Refund processed',
    cleanText: 'A refund of INR 799.00 was processed to your card ending 8842.',
  },
  {
    id: 'held-bank-offer',
    description: 'Credit card promotion',
    expectedShouldNotify: false,
    fromEmail: 'offers@bank.example',
    fromName: 'Bank Offers',
    subject: 'Earn more reward points',
    cleanText: 'Upgrade to a premium credit card and earn bonus reward points on every spend.',
  },
  {
    id: 'held-work-payroll',
    description: 'Payroll deadline',
    expectedShouldNotify: true,
    fromEmail: 'payroll@company.example',
    fromName: 'Payroll',
    subject: 'Submit investment declarations by 31 October',
    cleanText:
      'Please submit your tax investment declarations by 31 October for payroll processing.',
  },
  {
    id: 'held-work-security',
    description: 'Access security warning',
    expectedShouldNotify: true,
    fromEmail: 'security@company.example',
    fromName: 'Security Team',
    subject: 'Unusual sign-in to your account',
    cleanText: 'We blocked an unusual sign-in to your account. Review active sessions now.',
  },
  {
    id: 'held-work-bulk',
    description: 'Routine company bulk mail',
    expectedShouldNotify: false,
    fromEmail: 'facilities@company.example',
    fromName: 'Facilities',
    subject: 'Cafeteria menu this week',
    cleanText: 'Here is this week’s cafeteria menu and office sports schedule.',
  },
  {
    id: 'held-career-interview',
    description: 'Interview scheduling',
    expectedShouldNotify: true,
    fromEmail: 'recruiting@career.example',
    fromName: 'Recruiting',
    subject: 'Schedule your interview',
    cleanText: 'Please choose a slot for your interview on Thursday or Friday.',
  },
  {
    id: 'held-career-rejection',
    description: 'Application rejection',
    expectedShouldNotify: true,
    fromEmail: 'recruiting@career.example',
    fromName: 'Recruiting',
    subject: 'Update on your application',
    cleanText: 'Thank you for applying. We have decided not to move forward with your application.',
  },
  {
    id: 'held-career-update',
    description: 'Application assessment update',
    expectedShouldNotify: true,
    fromEmail: 'assessments@career.example',
    fromName: 'Assessments',
    subject: 'Your assessment is ready',
    cleanText: 'Your online assessment is ready. Please complete it within 48 hours.',
  },
  {
    id: 'held-career-ad',
    description: 'Generic job advertisement',
    expectedShouldNotify: false,
    fromEmail: 'jobs@career.example',
    fromName: 'Job Board',
    subject: '50 new jobs near you',
    cleanText: 'Browse new job advertisements that match your profile and location.',
  },
  {
    id: 'held-other-personal',
    description: 'Personal request with deadline',
    expectedShouldNotify: true,
    fromEmail: 'friend@personal.example',
    fromName: 'A Friend',
    subject: 'Can you send this today?',
    cleanText:
      'I need the signed form today for the visa appointment. Can you send it this evening?',
  },
  {
    id: 'held-other-newsletter',
    description: 'Low-value newsletter',
    expectedShouldNotify: false,
    fromEmail: 'digest@news.example',
    fromName: 'Daily Digest',
    subject: '10 things to read this weekend',
    cleanText: 'A roundup of articles, recipes, and weekend reading recommendations.',
  },
]

export interface EvaluationCaseResult {
  id: string
  description: string
  expected: boolean
  actual: boolean | null
  correct: boolean
  topic: string | null
  category: string | null
  confidence: number | null
  latencyMs: number
  costUsd: number
  error?: string
}

export interface EvaluationMetrics {
  cases: number
  truePositives: number
  falsePositives: number
  trueNegatives: number
  falseNegatives: number
  errors: number
  recall: number
  precision: number
  totalCostUsd: number
  averageLatencyMs: number
}

export function computeEvaluationMetrics(
  results: readonly EvaluationCaseResult[],
): EvaluationMetrics {
  let truePositives = 0
  let falsePositives = 0
  let trueNegatives = 0
  let falseNegatives = 0
  let errors = 0
  let totalCostUsd = 0
  let totalLatencyMs = 0

  for (const result of results) {
    totalCostUsd += result.costUsd
    totalLatencyMs += result.latencyMs
    if (result.actual === null) {
      errors += 1
      continue
    }
    if (result.expected && result.actual) truePositives += 1
    else if (!result.expected && result.actual) falsePositives += 1
    else if (!result.expected && !result.actual) trueNegatives += 1
    else falseNegatives += 1
  }

  const positives = truePositives + falseNegatives
  const predictedPositives = truePositives + falsePositives
  return {
    cases: results.length,
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    errors,
    recall: positives > 0 ? truePositives / positives : 0,
    precision: predictedPositives > 0 ? truePositives / predictedPositives : 0,
    totalCostUsd,
    averageLatencyMs: results.length > 0 ? totalLatencyMs / results.length : 0,
  }
}

export interface RunEvaluationOptions {
  classifier: MailClassifier
  examples?: readonly FeedbackExample[]
  cases?: readonly EvaluationCase[]
  companyDomains?: readonly string[]
  bankSenders?: readonly string[]
  maxInputChars?: number
}

/**
 * Run the real (or injected) classifier over the held-out cases. Prompt examples are fixed and
 * disjoint from the scored cases. A failed model call is recorded as an error and excluded from
 * recall/precision denominators rather than being treated as a successful decision.
 */
export async function runEvaluation(
  options: RunEvaluationOptions,
): Promise<EvaluationCaseResult[]> {
  const cases = options.cases ?? HELD_OUT_EVALUATION_CASES
  const examples = options.examples ?? EVALUATION_PROMPT_EXAMPLES
  const maxInputChars = options.maxInputChars ?? 12_000
  const results: EvaluationCaseResult[] = []

  for (const testCase of cases) {
    const started = performance.now()
    try {
      const prompt = buildClassifierPrompt({
        message: {
          accountEmail: 'eval@example.test',
          fromEmail: testCase.fromEmail,
          fromName: testCase.fromName,
          toEmails: ['eval@example.test'],
          ccEmails: [],
          subject: testCase.subject,
          receivedAt: new Date('2026-10-22T12:00:00Z'),
          cleanText: testCase.cleanText,
          headers: {},
        },
        examples,
        companyDomains: options.companyDomains ?? [],
        bankSenders: options.bankSenders ?? [],
        maxInputChars,
      })
      const response = await options.classifier({
        instructions: prompt.instructions,
        input: prompt.input,
      })
      const latencyMs = Math.round(performance.now() - started)
      results.push({
        id: testCase.id,
        description: testCase.description,
        expected: testCase.expectedShouldNotify,
        actual: response.output.shouldNotify,
        correct: response.output.shouldNotify === testCase.expectedShouldNotify,
        topic: response.output.topic,
        category: response.output.category,
        confidence: response.output.confidence,
        latencyMs,
        costUsd: response.usage.costUsd ?? 0,
      })
    } catch (error) {
      results.push({
        id: testCase.id,
        description: testCase.description,
        expected: testCase.expectedShouldNotify,
        actual: null,
        correct: false,
        topic: null,
        category: null,
        confidence: null,
        latencyMs: Math.round(performance.now() - started),
        costUsd: 0,
        error: errorMessage(error),
      })
    }
  }

  return results
}

export function formatEvaluationReport(
  effort: MailReasoningEffort,
  results: readonly EvaluationCaseResult[],
): string {
  const metrics = computeEvaluationMetrics(results)
  const percentage = (value: number): string => `${(value * 100).toFixed(1)}%`
  const lines = [
    `${effort} reasoning`,
    `cases ${metrics.cases}, TP ${metrics.truePositives}, FP ${metrics.falsePositives}, ` +
      `TN ${metrics.trueNegatives}, FN ${metrics.falseNegatives}, errors ${metrics.errors}`,
    `recall ${percentage(metrics.recall)}, precision ${percentage(metrics.precision)}`,
    `cost $${metrics.totalCostUsd.toFixed(4)}, avg latency ${Math.round(metrics.averageLatencyMs)} ms`,
  ]
  const mismatches = results.filter((result) => result.actual !== null && !result.correct)
  if (mismatches.length > 0) {
    lines.push(`mismatches: ${mismatches.map((result) => result.id).join(', ')}`)
  }
  const errors = results.filter((result) => result.actual === null)
  if (errors.length > 0) {
    lines.push(`errors: ${errors.map((result) => result.id).join(', ')}`)
  }
  return lines.join('\n')
}
