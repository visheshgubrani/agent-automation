import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailConfig } from '../../src/config.js'
import {
  emailClassifications,
  llmCalls,
  messages,
  notificationOutbox,
  runs,
} from '../../src/db/schema/index.js'
import { handleMailTriageJob } from '../../src/jobs/mail-triage.js'
import { getMailSpendStatus } from '../../src/mail/budget.js'
import { ClassifierRefusalError } from '../../src/mail/classifier-errors.js'
import type { MailClassifier } from '../../src/mail/openai-classifier.js'
import {
  createAccount,
  createMailboxSyncState,
  createMailRule,
  createMessage,
  createRun,
  createUserSettings,
} from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

const NOW = new Date('2026-10-22T12:00:00Z')
const JOB_ID = '11111111-2222-4333-8444-555555555555'

const mail: MailConfig = {
  gmail: { clientId: 'client-id', clientSecret: 'client-secret' },
  openaiApiKey: 'sk-test',
  model: 'gpt-6-luna',
  reasoningEffort: 'medium',
  maxInputChars: 12_000,
  maxOutputTokens: 2_000,
  requestTimeoutMs: 30_000,
  gmailRequestDelayMs: 0,
}

const output = {
  topic: 'banking' as const,
  category: 'fyi' as const,
  shouldNotify: true,
  confidence: 0.9,
  summary: 'Debit of INR 500 posted',
  reason: 'bank debit alert',
}

function fakeClassifier(): MailClassifier {
  return vi.fn(async () => ({
    output,
    usage: {
      promptTokens: 900,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 80,
      reasoningTokens: 20,
      costUsd: 0.00013,
      providerRequestId: 'resp_test',
    },
  }))
}

async function currentClassification(messageId: string) {
  const [row] = await db
    .select()
    .from(emailClassifications)
    .where(
      and(eq(emailClassifications.messageId, messageId), isNull(emailClassifications.supersededAt)),
    )
  return row
}

describe('mail triage job', () => {
  it('classifies with the Responses model, records provenance, and audits the paid attempt', async () => {
    await createUserSettings({ dailySpendLimitUsd: '1.00' })
    const account = await createAccount()
    const message = await createMessage(account.id, {
      fromEmail: 'alerts@bank.test',
      subject: 'Debit alert',
      rawText: 'RAW BODY MUST NOT REACH PROMPT',
      cleanText: 'A debit of INR 500 posted to your account.',
    })
    const classifier = fakeClassifier()

    const outcome = await handleMailTriageJob({
      jobId: JOB_ID,
      data: { source: 'manual' },
      mail,
      classifier,
      now: NOW,
    })

    expect(outcome).toMatchObject({ runOpened: true, paused: false, pending: 0 })
    expect(outcome.result).toMatchObject({ classified: 1, rulesApplied: 0, failed: 0 })
    expect(classifier).toHaveBeenCalledTimes(1)
    const call = (classifier as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      instructions: string
      input: string
    }
    expect(call.instructions).toContain('untrusted data')
    expect(call.input).toContain('A debit of INR 500 posted')
    expect(call.input).not.toContain('RAW BODY MUST NOT REACH PROMPT')

    const classification = await currentClassification(message.id)
    expect(classification).toMatchObject({
      category: 'fyi',
      topic: 'banking',
      shouldNotify: true,
      summary: 'Debit of INR 500 posted',
      reason: 'bank debit alert',
      decisionSource: 'classifier',
      model: 'gpt-6-luna',
      reasoningEffort: 'medium',
      confidence: '0.900',
    })

    const [stored] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(stored?.triageStatus).toBe('classified')

    const calls = await db.select().from(llmCalls)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      purpose: 'classify_email',
      model: 'gpt-6-luna',
      status: 'succeeded',
      reasoningEffort: 'medium',
      promptTokens: 900,
      completionTokens: 80,
      reasoningTokens: 20,
      providerRequestId: 'resp_test',
    })
    expect(Number(calls[0]?.reservedCostUsd)).toBeGreaterThan(0)
    expect(Number(calls[0]?.costUsd)).toBeCloseTo(0.00013, 6)

    const [run] = await db.select().from(runs)
    expect(run).toMatchObject({
      kind: 'mail_triage',
      trigger: 'manual',
      status: 'succeeded',
      bossJobId: JOB_ID,
    })
    expect(classification?.runId).toBe(run?.id)
    expect(calls[0]?.runId).toBe(run?.id)
  })

  it('produces one canonical alert for a live important arrival', async () => {
    await createUserSettings({ dailySpendLimitUsd: '1.00' })
    const account = await createAccount({ emailAddress: 'work@example.test' })
    await createMailboxSyncState(account.id, {
      notificationBoundaryAt: new Date('2026-10-22T10:00:00Z'),
    })
    await createMessage(account.id, {
      fromEmail: 'alerts@bank.test',
      subject: 'Debit alert',
      receivedAt: new Date('2026-10-22T11:00:00Z'),
    })
    const classifier = fakeClassifier()

    const outcome = await handleMailTriageJob({ jobId: JOB_ID, mail, classifier, now: NOW })

    expect(outcome.result).toMatchObject({ classified: 1, rulesApplied: 0, failed: 0 })
    const alerts = await db.select().from(notificationOutbox)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      kind: 'email_triage',
      status: 'pending',
      deliveryPolicy: 'at_least_once',
    })
    expect(alerts[0]?.body).toContain('Account: work@example.test')
    expect(alerts[0]?.body).toContain('Debit of INR 500 posted')
    const payload = alerts[0]?.payload as { inlineButtons?: unknown }
    expect(Array.isArray(payload.inlineButtons)).toBe(true)
  })

  it('keeps silent backfill classified without creating an alert', async () => {
    await createUserSettings({ dailySpendLimitUsd: '1.00' })
    const account = await createAccount()
    await createMailboxSyncState(account.id, {
      notificationBoundaryAt: new Date('2026-10-22T10:00:00Z'),
    })
    await createMessage(account.id, {
      receivedAt: new Date('2026-10-22T09:00:00Z'),
    })

    const outcome = await handleMailTriageJob({
      jobId: JOB_ID,
      mail,
      classifier: fakeClassifier(),
      now: NOW,
    })

    expect(outcome.result).toMatchObject({ classified: 1 })
    expect(await db.select().from(notificationOutbox)).toHaveLength(0)
  })

  it('applies a matching explicit rule without a model call', async () => {
    await createUserSettings({ dailySpendLimitUsd: '1.00' })
    const account = await createAccount()
    const message = await createMessage(account.id, {
      fromEmail: 'alerts@bank.test',
      subject: 'Debit alert',
    })
    const rule = await createMailRule({
      action: 'ignore',
      matchType: 'sender',
      matchValue: 'alerts@bank.test',
    })
    const classifier = vi.fn(async () => {
      throw new Error('the classifier must not run for a rule decision')
    }) as unknown as MailClassifier

    const outcome = await handleMailTriageJob({ jobId: JOB_ID, mail, classifier, now: NOW })

    expect(outcome).toMatchObject({ runOpened: true, paused: false })
    expect(outcome.result).toMatchObject({ rulesApplied: 1, classified: 0, failed: 0 })
    expect(classifier).not.toHaveBeenCalled()

    const classification = await currentClassification(message.id)
    expect(classification).toMatchObject({
      decisionSource: 'rule',
      appliedRuleId: rule.id,
      shouldNotify: false,
      category: null,
      confidence: null,
      model: null,
      promptVersion: null,
      classifierVersion: null,
      reasoningEffort: null,
    })
    expect(await db.select().from(llmCalls)).toHaveLength(0)
  })

  it('applies a matching rule even when it is behind a large non-matching backlog', async () => {
    await createUserSettings({ dailySpendLimitUsd: '0.00' })
    const account = await createAccount()
    for (let index = 0; index < 60; index += 1) {
      await createMessage(account.id, {
        fromEmail: `bulk-${index}@example.test`,
        receivedAt: new Date('2026-10-22T11:00:00Z'),
      })
    }
    const matched = await createMessage(account.id, {
      fromEmail: 'rule@example.test',
      receivedAt: new Date('2026-10-20T11:00:00Z'),
    })
    const rule = await createMailRule({
      action: 'notify',
      matchType: 'sender',
      matchValue: 'rule@example.test',
    })
    const classifier = vi.fn(async () => {
      throw new Error('the classifier must not run while the budget is exhausted')
    }) as unknown as MailClassifier

    const outcome = await handleMailTriageJob({ jobId: JOB_ID, mail, classifier, now: NOW })

    expect(outcome).toMatchObject({ runOpened: true, paused: true })
    expect(outcome.result).toMatchObject({ rulesApplied: 1, classified: 0 })
    expect(classifier).not.toHaveBeenCalled()
    expect(await currentClassification(matched.id)).toMatchObject({
      decisionSource: 'rule',
      appliedRuleId: rule.id,
      shouldNotify: true,
    })
  })

  it('pauses model work at the daily budget, keeps mail queued, and notices only once per day', async () => {
    await createUserSettings({ dailySpendLimitUsd: '0.00' })
    const account = await createAccount()
    const message = await createMessage(account.id)
    const classifier = fakeClassifier()

    const first = await handleMailTriageJob({ jobId: JOB_ID, mail, classifier, now: NOW })
    expect(first).toMatchObject({ runOpened: false, paused: true, pending: 1 })
    expect(classifier).not.toHaveBeenCalled()

    const second = await handleMailTriageJob({ jobId: JOB_ID, mail, classifier, now: NOW })
    expect(second).toMatchObject({ runOpened: false, paused: true, pending: 1 })

    const [stored] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(stored?.triageStatus).toBe('pending')
    expect(await currentClassification(message.id)).toBeUndefined()

    const notices = await db.select().from(notificationOutbox)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      kind: 'system',
      dedupeKey: 'system:mail-budget:2026-10-22',
    })
    expect(notices[0]?.body).toContain('1 message(s) remain queued')
  })

  it('resumes after the local-day boundary', async () => {
    await createUserSettings({ dailySpendLimitUsd: '1.00' })
    const run = await createRun()
    await db.insert(llmCalls).values({
      runId: run.id,
      purpose: 'classify_email',
      model: 'gpt-6-luna',
      status: 'succeeded',
      costUsd: '1.000000',
      createdAt: new Date('2026-10-22T10:00:00Z'),
    })

    const sameDay = await getMailSpendStatus(db, {
      now: NOW,
      model: mail.model,
      maxInputChars: mail.maxInputChars,
      maxOutputTokens: mail.maxOutputTokens,
    })
    expect(sameDay.canAdmit).toBe(false)
    expect(sameDay.remainingUsd).toBe(0)

    const nextDay = await getMailSpendStatus(db, {
      now: new Date('2026-10-23T18:30:01Z'),
      model: mail.model,
      maxInputChars: mail.maxInputChars,
      maxOutputTokens: mail.maxOutputTokens,
    })
    expect(nextDay.range.dayKey).toBe('2026-10-24')
    expect(nextDay.usage.totalUsd).toBe(0)
    expect(nextDay.canAdmit).toBe(true)
  })

  it('schedules transient failures with backoff and terminates refusals visibly', async () => {
    await createUserSettings({ dailySpendLimitUsd: '1.00' })
    const account = await createAccount()
    const transientMessage = await createMessage(account.id, { subject: 'Transient' })
    const refusedMessage = await createMessage(account.id, { subject: 'Refused' })

    const transient = vi.fn(async (call: { input: string }) => {
      if (call.input.includes('Transient')) throw new Error('rate limited')
      throw new ClassifierRefusalError('policy refusal')
    }) as unknown as MailClassifier

    const first = await handleMailTriageJob({
      jobId: JOB_ID,
      mail,
      classifier: transient,
      now: NOW,
    })
    expect(first.result).toMatchObject({ failed: 2, classified: 0 })

    const [backedOff] = await db.select().from(messages).where(eq(messages.id, transientMessage.id))
    expect(backedOff?.triageStatus).toBe('failed')
    expect(backedOff?.triageNextAttemptAt).toBeInstanceOf(Date)
    expect(backedOff?.triageLastError).toContain('rate limited')

    // Both messages are claimed fairly; the refusal is terminal, the rate limit is not.
    const [refused] = await db.select().from(messages).where(eq(messages.id, refusedMessage.id))
    expect(refused?.triageStatus).toBe('failed')
    expect(refused?.triageAttempts).toBe(5)
    expect(refused?.triageNextAttemptAt).toBeNull()
    expect(refused?.triageLastError).toContain('policy refusal')

    const immediate = await handleMailTriageJob({
      jobId: JOB_ID,
      mail,
      classifier: transient,
      now: NOW,
    })
    expect(immediate).toMatchObject({ runOpened: false, pending: 0 })
  })
})
