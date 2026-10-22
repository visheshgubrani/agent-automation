import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { emailClassifications, messages, notificationOutbox } from '../../src/db/schema/index.js'
import { emailTriageAlertButtons, produceEmailTriageAlert } from '../../src/mail/alerts.js'
import {
  recordClassifierDecision,
  recordClassifierDecisionInTransaction,
  recordRuleDecision,
} from '../../src/mail/classification.js'
import {
  createAccount,
  createClassification,
  createFeedback,
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
const NOW = new Date('2026-10-22T12:00:00Z')

const decision = {
  topic: 'banking' as const,
  category: 'fyi' as const,
  shouldNotify: true,
  confidence: 0.9,
  summary: 'Debit of INR 500 posted to your card ending 1234',
  reason: 'Bank transaction alert',
}

async function liveMessage(
  overrides: {
    emailAddress?: string
    rfcMessageId?: string | null
    receivedAt?: Date
    boundary?: Date | null
    providerThreadId?: string | null
  } = {},
) {
  const account = await createAccount({
    ...(overrides.emailAddress !== undefined ? { emailAddress: overrides.emailAddress } : {}),
  })
  await createMailboxSyncState(account.id, {
    notificationBoundaryAt: overrides.boundary === undefined ? BOUNDARY : overrides.boundary,
  })
  const run = await createRun()
  const message = await createMessage(account.id, {
    fromEmail: 'alerts@bank.test',
    fromName: 'Bank Alerts',
    subject: 'Debit alert',
    cleanText: 'A debit of INR 500 posted.',
    receivedAt: overrides.receivedAt ?? AFTER_BOUNDARY,
    ...(overrides.rfcMessageId !== undefined ? { rfcMessageId: overrides.rfcMessageId } : {}),
    ...(overrides.providerThreadId !== undefined
      ? { providerThreadId: overrides.providerThreadId }
      : {}),
  })
  return { account, run, message }
}

function classifyInput(messageId: string, runId: string, shouldNotify = true) {
  return {
    messageId,
    runId,
    decision: { ...decision, shouldNotify },
    model: 'gpt-6-luna',
    promptVersion: 'mail-prompts-v1',
    classifierVersion: 'mail-classifier-v1',
    reasoningEffort: 'medium' as const,
    now: NOW,
  }
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

async function notifications() {
  return db.select().from(notificationOutbox)
}

describe('automatic email alert production', () => {
  it('commits the classification, message status, and canonical outbox row together', async () => {
    const { account, run, message } = await liveMessage({
      rfcMessageId: '<live@example.test>',
    })
    const row = await recordClassifierDecision(db, classifyInput(message.id, run.id))

    const [stored] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(stored?.triageStatus).toBe('classified')

    const rows = await notifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'email_triage',
      status: 'pending',
      deliveryPolicy: 'at_least_once',
      classificationId: row.id,
      dedupeKey: 'email_triage:rfc:live@example.test',
    })
    expect(rows[0]?.body).toContain(`Account: ${account.emailAddress}`)
    expect(rows[0]?.body).toContain('From: Bank Alerts <alerts@bank.test>')
    expect(rows[0]?.body).toContain('Subject: Debit alert')
    expect(rows[0]?.body).toContain('Summary: Debit of INR 500 posted')
    expect(rows[0]?.body).toContain('Why: Bank transaction alert')
    expect(rows[0]?.body).toContain('Open in Gmail: https://mail.google.com/mail/u/')
    expect(rows[0]?.payload).toMatchObject({
      version: 1,
      messageId: message.id,
      accountId: account.id,
      inlineButtons: emailTriageAlertButtons(row.id),
    })
  })

  it('keeps the initial seven-day backfill silent but still classifies it', async () => {
    const { run, message } = await liveMessage({ receivedAt: BEFORE_BOUNDARY })
    const row = await recordClassifierDecision(db, classifyInput(message.id, run.id))

    expect(row.shouldNotify).toBe(true)
    expect(await notifications()).toHaveLength(0)
    expect((await currentClassification(message.id))?.id).toBe(row.id)
    expect(
      (await db.select().from(messages).where(eq(messages.id, message.id)))[0]?.triageStatus,
    ).toBe('classified')
  })

  it('produces no automatic alert while the connection boundary is unset', async () => {
    const { run, message } = await liveMessage({ boundary: null })
    await recordClassifierDecision(db, classifyInput(message.id, run.id))
    expect(await notifications()).toHaveLength(0)
  })

  it('does not notify for a negative classification', async () => {
    const { run, message } = await liveMessage()
    await recordClassifierDecision(db, classifyInput(message.id, run.id, false))
    expect(await notifications()).toHaveLength(0)
  })

  it('collapses the same RFC Message-ID across inboxes into one outbox row', async () => {
    const first = await liveMessage({
      emailAddress: 'one@example.test',
      rfcMessageId: '<shared@example.test>',
    })
    const second = await liveMessage({
      emailAddress: 'two@example.test',
      rfcMessageId: '<shared@example.test>',
    })

    const firstRow = await recordClassifierDecision(
      db,
      classifyInput(first.message.id, first.run.id),
    )
    await recordClassifierDecision(db, classifyInput(second.message.id, second.run.id))

    const rows = await notifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.classificationId).toBe(firstRow.id)
    expect(rows[0]?.dedupeKey).toBe('email_triage:rfc:shared@example.test')
    expect((await currentClassification(second.message.id))?.shouldNotify).toBe(true)
  })

  it('uses the stable stored message id when the RFC header is missing', async () => {
    const { run, message } = await liveMessage({ rfcMessageId: null })

    await recordClassifierDecision(db, classifyInput(message.id, run.id))
    await recordClassifierDecision(db, classifyInput(message.id, run.id))

    const rows = await notifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dedupeKey).toBe(`email_triage:message:${message.id}`)
  })

  it('notifies for an explicit notify rule without a model decision', async () => {
    const { run, message } = await liveMessage({ rfcMessageId: '<rule@example.test>' })
    const rule = await createMailRule({
      action: 'notify',
      matchType: 'sender',
      matchValue: 'alerts@bank.test',
    })

    const row = await recordRuleDecision(db, {
      messageId: message.id,
      runId: run.id,
      rule,
      now: NOW,
    })

    const rows = await notifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      classificationId: row.id,
      dedupeKey: 'email_triage:rfc:rule@example.test',
    })
    expect(rows[0]?.body).toContain('Matched notify rule')
  })
})

describe('canonical corrections', () => {
  it('suppresses another inbox copy when the canonical email was marked unimportant', async () => {
    const first = await liveMessage({
      emailAddress: 'one@example.test',
      rfcMessageId: '<shared@example.test>',
    })
    const second = await liveMessage({
      emailAddress: 'two@example.test',
      rfcMessageId: '<shared@example.test>',
    })

    await createClassification(first.message.id, first.run.id, {
      decisionSource: 'correction',
      shouldNotify: false,
      category: null,
      confidence: null,
      model: null,
      promptVersion: null,
      classifierVersion: null,
      reasoningEffort: null,
      summary: null,
      reason: 'You marked this email as not important.',
    })

    await recordClassifierDecision(db, classifyInput(second.message.id, second.run.id))
    expect(await notifications()).toHaveLength(0)
  })

  it('honours a feedback label even without a correction classification row', async () => {
    const first = await liveMessage({
      emailAddress: 'one@example.test',
      rfcMessageId: '<shared@example.test>',
    })
    const second = await liveMessage({
      emailAddress: 'two@example.test',
      rfcMessageId: '<shared@example.test>',
    })

    const firstClassification = await createClassification(first.message.id, first.run.id, {
      shouldNotify: true,
    })
    await createFeedback(firstClassification.id, {
      rating: 'not_useful',
      reason: 'too_noisy',
    })

    await recordClassifierDecision(db, classifyInput(second.message.id, second.run.id))
    expect(await notifications()).toHaveLength(0)
  })

  it('lets an explicit missed-important correction bypass the silent boundary', async () => {
    const { run, message } = await liveMessage({ receivedAt: BEFORE_BOUNDARY })
    const row = await recordClassifierDecision(db, classifyInput(message.id, run.id, false))

    const result = await produceEmailTriageAlert(db, {
      messageId: message.id,
      classification: {
        id: row.id,
        shouldNotify: true,
        summary: 'The client asks for a reply today.',
        reason: 'You marked this email as important.',
      },
      allowBeforeBoundary: true,
    })

    expect(result.outcome).toBe('enqueued')
    const rows = await notifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toContain('You marked this email as important.')
  })

  it('honours a positive canonical correction for a later backfilled copy', async () => {
    const corrected = await liveMessage({
      emailAddress: 'one@example.test',
      rfcMessageId: '<shared@example.test>',
    })
    const copy = await liveMessage({
      emailAddress: 'two@example.test',
      rfcMessageId: '<shared@example.test>',
      receivedAt: BEFORE_BOUNDARY,
    })

    await createClassification(corrected.message.id, corrected.run.id, {
      decisionSource: 'correction',
      shouldNotify: true,
      category: null,
      confidence: null,
      model: null,
      promptVersion: null,
      classifierVersion: null,
      reasoningEffort: null,
      summary: null,
      reason: 'You marked this email as important.',
    })

    await recordClassifierDecision(db, classifyInput(copy.message.id, copy.run.id, false))
    const rows = await notifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toContain('You marked this email as important.')
  })

  it('does not apply a canonical correction to a different email in the same thread', async () => {
    const corrected = await liveMessage({
      emailAddress: 'one@example.test',
      rfcMessageId: '<first@example.test>',
      providerThreadId: 'thread-1',
    })
    const differentMessage = await createMessage(corrected.account.id, {
      fromEmail: 'alerts@bank.test',
      subject: 'Second email in the thread',
      receivedAt: AFTER_BOUNDARY,
      rfcMessageId: '<second@example.test>',
      providerThreadId: 'thread-1',
    })

    await createClassification(corrected.message.id, corrected.run.id, {
      decisionSource: 'correction',
      shouldNotify: false,
      category: null,
      confidence: null,
      model: null,
      promptVersion: null,
      classifierVersion: null,
      reasoningEffort: null,
      summary: null,
      reason: 'Not important',
    })

    await recordClassifierDecision(db, classifyInput(differentMessage.id, corrected.run.id))
    const rows = await notifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dedupeKey).toBe('email_triage:rfc:second@example.test')
  })
})

describe('transaction composition', () => {
  it('rolls back classification, message status, and notification together', async () => {
    const { run, message } = await liveMessage()

    await expect(
      db.transaction(async (tx) => {
        await recordClassifierDecisionInTransaction(tx, classifyInput(message.id, run.id))
        throw new Error('rollback after decision')
      }),
    ).rejects.toThrow('rollback after decision')

    const [stored] = await db.select().from(messages).where(eq(messages.id, message.id))
    expect(stored?.triageStatus).toBe('pending')
    expect(await currentClassification(message.id)).toBeUndefined()
    expect(await notifications()).toHaveLength(0)
  })
})
