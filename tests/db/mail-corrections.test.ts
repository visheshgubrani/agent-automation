import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  classificationFeedback,
  emailClassifications,
  notificationOutbox,
} from '../../src/db/schema/index.js'
import { recordClassifierDecision, recordRuleDecision } from '../../src/mail/classification.js'
import {
  applyMessageCorrection,
  InvalidCorrectionError,
  StaleClassificationError,
} from '../../src/mail/corrections.js'
import {
  createAccount,
  createClassification,
  createEmailNotification,
  createMailboxSyncState,
  createMailRule,
  createMessage,
  createRun,
} from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

const BOUNDARY = new Date('2026-10-22T10:00:00Z')
const AFTER_BOUNDARY = new Date('2026-10-22T11:00:00Z')
const BEFORE_BOUNDARY = new Date('2026-10-22T09:00:00Z')
const NOW = new Date('2026-10-23T12:00:00Z')

async function accountWithBoundary(emailAddress: string, boundary = BOUNDARY) {
  const account = await createAccount({ emailAddress })
  await createMailboxSyncState(account.id, { notificationBoundaryAt: boundary })
  return account
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

async function feedbackFor(classificationId: string) {
  const [row] = await db
    .select()
    .from(classificationFeedback)
    .where(eq(classificationFeedback.classificationId, classificationId))
  return row
}

async function notifications() {
  return db.select().from(notificationOutbox)
}

function classifierInput(messageId: string, runId: string, shouldNotify = true) {
  return {
    messageId,
    runId,
    decision: {
      topic: 'banking' as const,
      category: 'fyi' as const,
      shouldNotify,
      confidence: 0.9,
      summary: 'Debit of INR 500 posted',
      reason: 'Bank transaction alert',
    },
    model: 'gpt-6-luna',
    promptVersion: 'mail-prompts-v1',
    classifierVersion: 'mail-classifier-v1',
    reasoningEffort: 'medium' as const,
    now: NOW,
  }
}

describe('important corrections', () => {
  it('applies across canonical copies, pins feedback, and alerts silent backfill once', async () => {
    const first = await accountWithBoundary('one@example.test')
    const second = await accountWithBoundary('two@example.test')
    const run = await createRun()
    const firstMessage = await createMessage(first.id, {
      rfcMessageId: '<shared@example.test>',
      receivedAt: BEFORE_BOUNDARY,
      subject: 'Client request',
      fromEmail: 'client@example.test',
    })
    const secondMessage = await createMessage(second.id, {
      rfcMessageId: '<shared@example.test>',
      receivedAt: BEFORE_BOUNDARY,
      subject: 'Client request',
      fromEmail: 'client@example.test',
    })
    const firstClassification = await createClassification(firstMessage.id, run.id, {
      shouldNotify: false,
      summary: 'Client asks for a reply.',
    })
    const secondClassification = await createClassification(secondMessage.id, run.id, {
      shouldNotify: false,
      summary: 'Client asks for a reply.',
    })

    const result = await applyMessageCorrection(db, {
      displayedClassificationId: firstClassification.id,
      runId: run.id,
      important: true,
      notificationId: null,
      now: NOW,
    })

    expect(result).toMatchObject({
      affectedCopies: 2,
      insertedCorrections: 2,
      cancelledAlerts: 0,
    })
    expect(result.notificationOutcomes).toContain('enqueued')
    expect(result.notificationOutcomes).toContain('duplicate')

    const feedback = await feedbackFor(firstClassification.id)
    expect(feedback).toMatchObject({
      rating: 'useful',
      reason: 'missed_important',
      notificationId: null,
      note: 'Marked important from Telegram',
    })

    const firstCurrent = await currentClassification(firstMessage.id)
    const secondCurrent = await currentClassification(secondMessage.id)
    expect(firstCurrent).toMatchObject({
      decisionSource: 'correction',
      shouldNotify: true,
      summary: 'Client asks for a reply.',
      reason: 'Marked important from Telegram',
    })
    expect(secondCurrent).toMatchObject({ decisionSource: 'correction', shouldNotify: true })
    const [supersededSecond] = await db
      .select()
      .from(emailClassifications)
      .where(eq(emailClassifications.id, secondClassification.id))
    expect(supersededSecond?.supersededAt).toBeInstanceOf(Date)

    const rows = await notifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'email_triage',
      status: 'pending',
      dedupeKey: 'email_triage:rfc:shared@example.test',
    })
    expect([firstCurrent?.id, secondCurrent?.id]).toContain(rows[0]?.classificationId)
    expect(rows[0]?.body).toContain('Client asks for a reply.')
  })

  it('does not apply a correction to a different email in the same thread', async () => {
    const account = await accountWithBoundary('one@example.test')
    const run = await createRun()
    const first = await createMessage(account.id, {
      rfcMessageId: '<first@example.test>',
      providerThreadId: 'thread-1',
      receivedAt: BEFORE_BOUNDARY,
    })
    const second = await createMessage(account.id, {
      rfcMessageId: '<second@example.test>',
      providerThreadId: 'thread-1',
      receivedAt: BEFORE_BOUNDARY,
    })
    const firstClassification = await createClassification(first.id, run.id, {
      shouldNotify: false,
    })
    const secondClassification = await createClassification(second.id, run.id, {
      shouldNotify: false,
    })

    await applyMessageCorrection(db, {
      displayedClassificationId: firstClassification.id,
      runId: run.id,
      important: true,
      notificationId: null,
      now: NOW,
    })

    expect(await currentClassification(first.id)).toMatchObject({
      decisionSource: 'correction',
      shouldNotify: true,
    })
    expect(await currentClassification(second.id)).toMatchObject({
      id: secondClassification.id,
      decisionSource: 'classifier',
      shouldNotify: false,
    })
  })
})

describe('unimportant corrections', () => {
  it('cancels an unsent alert, links feedback, and a later important correction reactivates it', async () => {
    const account = await accountWithBoundary('one@example.test')
    const run = await createRun()
    const message = await createMessage(account.id, {
      rfcMessageId: '<live@example.test>',
      receivedAt: AFTER_BOUNDARY,
      summary: undefined,
    })
    const classification = await recordClassifierDecision(
      db,
      classifierInput(message.id, run.id, true),
    )
    const [alert] = await notifications()
    expect(alert?.status).toBe('pending')

    const result = await applyMessageCorrection(db, {
      displayedClassificationId: classification.id,
      runId: run.id,
      important: false,
      notificationId: alert?.id ?? null,
      now: NOW,
    })

    expect(result).toMatchObject({ cancelledAlerts: 1, insertedCorrections: 1 })
    const feedback = await feedbackFor(classification.id)
    expect(feedback).toMatchObject({
      rating: 'not_useful',
      reason: 'too_noisy',
      notificationId: alert?.id,
    })
    expect(await currentClassification(message.id)).toMatchObject({
      decisionSource: 'correction',
      shouldNotify: false,
    })

    const cancelled = (await notifications())[0]
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      lastError: 'cancelled by Telegram correction',
    })

    const correction = await currentClassification(message.id)
    if (!correction) throw new Error('expected a current correction')

    const reactivated = await applyMessageCorrection(db, {
      displayedClassificationId: correction.id,
      runId: run.id,
      important: true,
      notificationId: null,
      now: new Date(NOW.getTime() + 60_000),
    })

    expect(reactivated.notificationOutcomes).toContain('reactivated')
    const newCorrection = await currentClassification(message.id)
    const row = (await notifications())[0]
    expect(row).toMatchObject({
      status: 'pending',
      classificationId: newCorrection?.id,
      attemptCount: 0,
      sentAt: null,
      telegramMessageId: null,
    })
    expect(row?.body).toContain('Debit of INR 500 posted')
    expect(row?.classificationId).not.toBe(correction.id)
  })

  it('never rewrites a sent alert', async () => {
    const account = await accountWithBoundary('one@example.test')
    const run = await createRun()
    const message = await createMessage(account.id, {
      rfcMessageId: '<sent@example.test>',
      receivedAt: AFTER_BOUNDARY,
    })
    const classification = await createClassification(message.id, run.id, {
      shouldNotify: true,
    })
    const sentAt = new Date('2026-10-22T11:05:00Z')
    const sent = await createEmailNotification(classification.id, {
      dedupeKey: 'email_triage:rfc:sent@example.test',
      status: 'sent',
      sentAt,
      telegramMessageId: 777,
    })

    const result = await applyMessageCorrection(db, {
      displayedClassificationId: classification.id,
      runId: run.id,
      important: false,
      notificationId: sent.id,
      now: NOW,
    })

    expect(result.cancelledAlerts).toBe(0)
    const [row] = await notifications()
    expect(row).toMatchObject({
      id: sent.id,
      status: 'sent',
      sentAt,
      telegramMessageId: 777,
    })
  })

  it('rejects stale classifications and notification links from another classification', async () => {
    const account = await accountWithBoundary('one@example.test')
    const run = await createRun()
    const message = await createMessage(account.id, { receivedAt: AFTER_BOUNDARY })
    const otherMessage = await createMessage(account.id, { receivedAt: AFTER_BOUNDARY })
    const classification = await createClassification(message.id, run.id, {
      shouldNotify: true,
    })
    const otherClassification = await createClassification(otherMessage.id, run.id, {
      shouldNotify: true,
    })
    const otherNotification = await createEmailNotification(otherClassification.id, {
      dedupeKey: 'email_triage:rfc:other@example.test',
    })

    await expect(
      applyMessageCorrection(db, {
        displayedClassificationId: classification.id,
        runId: run.id,
        important: false,
        notificationId: otherNotification.id,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidCorrectionError)

    await applyMessageCorrection(db, {
      displayedClassificationId: classification.id,
      runId: run.id,
      important: false,
      notificationId: null,
      now: NOW,
    })
    await expect(
      applyMessageCorrection(db, {
        displayedClassificationId: classification.id,
        runId: run.id,
        important: true,
        notificationId: null,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(StaleClassificationError)
  })
})

describe('correction precedence', () => {
  it('refuses to let a later classifier or rule decision supersede a correction', async () => {
    const account = await accountWithBoundary('one@example.test')
    const run = await createRun()
    const message = await createMessage(account.id, { receivedAt: AFTER_BOUNDARY })
    const classification = await createClassification(message.id, run.id, {
      shouldNotify: false,
    })
    await applyMessageCorrection(db, {
      displayedClassificationId: classification.id,
      runId: run.id,
      important: true,
      notificationId: null,
      now: NOW,
    })
    const correction = await currentClassification(message.id)
    if (!correction) throw new Error('expected a correction')

    const classifierResult = await recordClassifierDecision(
      db,
      classifierInput(message.id, run.id, false),
    )
    expect(classifierResult.id).toBe(correction.id)

    const rule = await createMailRule({
      action: 'ignore',
      matchType: 'sender',
      matchValue: 'sender@example.test',
    })
    const ruleResult = await recordRuleDecision(db, {
      messageId: message.id,
      runId: run.id,
      rule,
      now: new Date(NOW.getTime() + 1_000),
    })
    expect(ruleResult.id).toBe(correction.id)

    const rows = await db
      .select()
      .from(emailClassifications)
      .where(eq(emailClassifications.messageId, message.id))
    expect(rows).toHaveLength(2) // the original classification plus the correction
    expect(await notifications()).toHaveLength(1)
  })
})
