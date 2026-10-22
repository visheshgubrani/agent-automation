import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { emailClassifications, messages } from '../../src/db/schema/index.js'
import {
  loadTriageMessage,
  recordClassifierDecision,
  recordRuleDecision,
} from '../../src/mail/classification.js'
import { loadFeedbackExamples } from '../../src/mail/examples.js'
import {
  createAccount,
  createClassification,
  createFeedback,
  createMailRule,
  createMessage,
  createRun,
} from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

const NOW = new Date('2026-10-22T12:00:00Z')

const decision = {
  topic: 'banking' as const,
  category: 'fyi' as const,
  shouldNotify: true,
  confidence: 0.85,
  summary: 'Debit of INR 500 posted',
  reason: 'bank debit alert',
}

describe('classification decisions', () => {
  it('records a classifier row, marks the message classified, and supersedes history', async () => {
    const account = await createAccount()
    const message = await createMessage(account.id, {
      cleanText: 'Your account was debited INR 500.',
      triageStatus: 'in_progress',
      triageAttempts: 1,
    })
    const run = await createRun()

    const first = await recordClassifierDecision(db, {
      messageId: message.id,
      runId: run.id,
      decision,
      model: 'gpt-6-luna',
      promptVersion: 'prompt-v1',
      classifierVersion: 'classifier-v1',
      reasoningEffort: 'medium',
      now: NOW,
    })
    expect(first).toMatchObject({
      messageId: message.id,
      runId: run.id,
      topic: 'banking',
      category: 'fyi',
      shouldNotify: true,
      confidence: '0.850',
      summary: 'Debit of INR 500 posted',
      reason: 'bank debit alert',
      decisionSource: 'classifier',
      reasoningEffort: 'medium',
      model: 'gpt-6-luna',
      promptVersion: 'prompt-v1',
      classifierVersion: 'classifier-v1',
      appliedRuleId: null,
    })

    const [classified] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(classified).toMatchObject({
      triageStatus: 'classified',
      triageNextAttemptAt: null,
      triageLastError: null,
    })

    const second = await recordClassifierDecision(db, {
      messageId: message.id,
      runId: run.id,
      decision: { ...decision, shouldNotify: false, summary: 'Routine bank promotion' },
      model: 'gpt-6-luna',
      promptVersion: 'prompt-v1',
      classifierVersion: 'classifier-v1',
      reasoningEffort: 'high',
      now: new Date(NOW.getTime() + 60_000),
    })

    const current = await db
      .select()
      .from(emailClassifications)
      .where(
        and(
          eq(emailClassifications.messageId, message.id),
          isNull(emailClassifications.supersededAt),
        ),
      )
    expect(current).toHaveLength(1)
    expect(current[0]?.id).toBe(second.id)
    expect(current[0]?.reasoningEffort).toBe('high')

    const [superseded] = await db
      .select()
      .from(emailClassifications)
      .where(eq(emailClassifications.id, first.id))
    expect(superseded?.supersededAt).toBeInstanceOf(Date)
  })

  it('records a rule decision with honest provenance and no model fields', async () => {
    const account = await createAccount()
    const message = await createMessage(account.id, { triageStatus: 'in_progress' })
    const run = await createRun()
    const rule = await createMailRule({
      action: 'ignore',
      matchType: 'domain',
      matchValue: 'example.test',
      subjectContains: 'newsletter',
    })

    const row = await recordRuleDecision(db, {
      messageId: message.id,
      runId: run.id,
      rule,
      now: NOW,
    })

    expect(row).toMatchObject({
      messageId: message.id,
      topic: 'other',
      category: null,
      shouldNotify: false,
      confidence: null,
      summary: null,
      decisionSource: 'rule',
      appliedRuleId: rule.id,
      reasoningEffort: null,
      model: null,
      promptVersion: null,
      classifierVersion: null,
    })
    expect(row.reason).toContain('ignore rule for domain example.test')
  })

  it('loads only clean prompt metadata for a claimed message', async () => {
    const account = await createAccount({ emailAddress: 'me@example.test' })
    const message = await createMessage(account.id, {
      fromEmail: 'alerts@bank.test',
      subject: 'Debit alert',
      rawText: 'RAW BODY THAT MUST NOT BE PROMPTED',
      cleanText: 'Clean debit text',
    })

    const loaded = await loadTriageMessage(db, message.id)
    expect(loaded).toMatchObject({
      id: message.id,
      accountId: account.id,
      accountEmail: 'me@example.test',
      fromEmail: 'alerts@bank.test',
      subject: 'Debit alert',
      cleanText: 'Clean debit text',
    })
    expect(loaded).not.toHaveProperty('rawText')
  })
})

describe('feedback examples', () => {
  it('prefers relevant labels and excludes the message and its canonical copies', async () => {
    const account = await createAccount()
    const run = await createRun()
    const current = await createMessage(account.id, {
      fromEmail: 'boss@company.test',
      rfcMessageId: '<current@example.test>',
    })

    const sameSender = await createMessage(account.id, {
      fromEmail: 'boss@company.test',
      subject: 'Direct request',
      cleanText: 'Please review this by Friday.',
      rfcMessageId: '<same-sender@example.test>',
    })
    const sameSenderClassification = await createClassification(sameSender.id, run.id, {
      category: 'ignore',
      shouldNotify: false,
      summary: 'Routine request',
    })
    await createFeedback(sameSenderClassification.id, {
      rating: 'not_useful',
      reason: 'missed_important',
    })

    const otherSender = await createMessage(account.id, {
      fromEmail: 'news@example.test',
      subject: 'Weekly newsletter',
      cleanText: 'Product news and offers.',
      rfcMessageId: '<other@example.test>',
    })
    const otherClassification = await createClassification(otherSender.id, run.id, {
      category: 'ignore',
      shouldNotify: false,
    })
    await createFeedback(otherClassification.id, { rating: 'not_useful', reason: 'too_noisy' })

    const copy = await createMessage(account.id, {
      fromEmail: 'boss@company.test',
      rfcMessageId: '<current@example.test>',
    })
    const copyClassification = await createClassification(copy.id, run.id, {
      category: 'ignore',
      shouldNotify: false,
    })
    await createFeedback(copyClassification.id, {
      rating: 'not_useful',
      reason: 'missed_important',
      note: 'same canonical email',
    })

    const selfClassification = await createClassification(current.id, run.id, {
      category: 'ignore',
      shouldNotify: false,
    })
    await createFeedback(selfClassification.id, { rating: 'not_useful' })

    const examples = await loadFeedbackExamples(db, {
      id: current.id,
      rfcMessageId: current.rfcMessageId,
      fromEmail: current.fromEmail,
    })

    expect(examples.map((example) => example.messageId)).toEqual([sameSender.id, otherSender.id])
    expect(examples[0]).toMatchObject({
      shouldNotify: true,
      reason: 'missed_important',
      subject: 'Direct request',
    })
    expect(examples[0]?.excerpt).toContain('review this by Friday')
    expect(examples[1]).toMatchObject({ shouldNotify: false, reason: 'too_noisy' })
    expect(examples.some((example) => example.messageId === copy.id)).toBe(false)
    expect(examples.some((example) => example.messageId === current.id)).toBe(false)
  })
})
