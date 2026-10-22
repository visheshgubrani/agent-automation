import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  classificationFeedback,
  classifierFeedbackExamples,
  notificationOutbox,
} from '../../src/db/schema/index.js'
import {
  createAccount,
  createClassification,
  createEmailNotification,
  createMessage,
  createRun,
  createSystemNotification,
} from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

async function emailContext() {
  const account = await createAccount()
  const run = await createRun()
  const message = await createMessage(account.id)
  const classification = await createClassification(message.id, run.id, { category: 'ignore' })
  return { account, run, message, classification }
}

describe('notification outbox', () => {
  it('rejects duplicate dedupe keys and invalid kind contexts', async () => {
    const { classification } = await emailContext()
    const notification = await createEmailNotification(classification.id)
    expect(notification.status).toBe('pending')

    await expect(createEmailNotification(classification.id)).rejects.toThrow()
    await expect(
      db.insert(notificationOutbox).values({
        kind: 'email_triage',
        dedupeKey: 'email-triage-without-classification',
        body: 'missing context',
      }),
    ).rejects.toThrow()
    await expect(
      db.insert(notificationOutbox).values({
        kind: 'approval_request',
        dedupeKey: 'approval-without-context',
        body: 'missing context',
      }),
    ).rejects.toThrow()
    await expect(
      db.insert(notificationOutbox).values({
        kind: 'system',
        dedupeKey: 'system-with-classification',
        body: 'wrong context',
        classificationId: classification.id,
      }),
    ).rejects.toThrow()
  })

  it('requires sent_at iff status is sent, and an expiry after creation', async () => {
    await expect(
      db.insert(notificationOutbox).values({
        kind: 'system',
        dedupeKey: 'sent-without-date',
        body: 'x',
        status: 'sent',
      }),
    ).rejects.toThrow()

    await expect(
      db.insert(notificationOutbox).values({
        kind: 'system',
        dedupeKey: 'expired-before-created',
        body: 'x',
        expiresAt: new Date(Date.now() - 60_000),
      }),
    ).rejects.toThrow()
  })

  it('accepts quarantined as a status and defaults delivery_policy to at_most_once', async () => {
    const quarantined = await createSystemNotification({ status: 'quarantined' })
    expect(quarantined.status).toBe('quarantined')
    expect(quarantined.deliveryPolicy).toBe('at_most_once')

    const plain = await createSystemNotification()
    expect(plain.deliveryPolicy).toBe('at_most_once')
  })

  it('validates delivery_policy against the enum and lets explicit rows set at_least_once', async () => {
    await expect(
      createSystemNotification({ deliveryPolicy: 'exactly_once' as never }),
    ).rejects.toThrow()

    const { classification } = await emailContext()
    const email = await createEmailNotification(classification.id, {
      deliveryPolicy: 'at_least_once',
    })
    expect(email.deliveryPolicy).toBe('at_least_once')
  })

  it('collapses the same email from two inboxes via one RFC Message-ID dedupe key', async () => {
    const accountA = await createAccount()
    const accountB = await createAccount()
    const run = await createRun()
    const sharedRfcId = '<shared-message@example.test>'
    const messageA = await createMessage(accountA.id, { rfcMessageId: sharedRfcId })
    const messageB = await createMessage(accountB.id, { rfcMessageId: sharedRfcId })
    const classificationA = await createClassification(messageA.id, run.id)
    const classificationB = await createClassification(messageB.id, run.id)
    const sharedKey = `email_triage:rfc:${sharedRfcId}`

    await createEmailNotification(classificationA.id, { dedupeKey: sharedKey })
    await expect(
      createEmailNotification(classificationB.id, { dedupeKey: sharedKey }),
    ).rejects.toThrow()
  })
})

describe('classification feedback and training view', () => {
  it('labels a missed, never-notified email and exposes it in the view', async () => {
    const { classification, message } = await emailContext()
    await db.insert(classificationFeedback).values({
      classificationId: classification.id,
      rating: 'not_useful',
      reason: 'missed_important',
      note: 'Important client email was ignored',
    })

    const rows = await db.select().from(classifierFeedbackExamples)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      rating: 'not_useful',
      reason: 'missed_important',
      notification_id: null,
      category: 'ignore',
      message_id: message.id,
      classification_id: classification.id,
    })
  })

  it('allows one label per classification but keeps the notification optional', async () => {
    const { classification } = await emailContext()
    await db.insert(classificationFeedback).values({
      classificationId: classification.id,
      rating: 'useful',
    })

    await expect(
      db.insert(classificationFeedback).values({
        classificationId: classification.id,
        rating: 'not_useful',
      }),
    ).rejects.toThrow()
  })

  it('links notified labels in the view and preserves them when the notification is pruned', async () => {
    const { classification } = await emailContext()
    const sentAt = new Date()
    const notification = await createEmailNotification(classification.id, {
      status: 'sent',
      sentAt,
    })
    await db.insert(classificationFeedback).values({
      classificationId: classification.id,
      notificationId: notification.id,
      rating: 'useful',
    })

    const [labeled] = await db.select().from(classifierFeedbackExamples)
    expect(labeled?.notification_id).toBe(notification.id)
    expect(labeled?.notification_sent_at).toBeInstanceOf(Date)

    await db.delete(notificationOutbox).where(eq(notificationOutbox.id, notification.id))
    const [feedback] = await db.select().from(classificationFeedback)
    expect(feedback?.notificationId).toBeNull()
  })

  it('prevents one notification from carrying feedback for two classifications', async () => {
    const { classification, run, account } = await emailContext()
    const secondMessage = await createMessage(account.id)
    const secondClassification = await createClassification(secondMessage.id, run.id)
    const notification = await createEmailNotification(classification.id)

    await db.insert(classificationFeedback).values({
      classificationId: classification.id,
      notificationId: notification.id,
      rating: 'useful',
    })
    await expect(
      db.insert(classificationFeedback).values({
        classificationId: secondClassification.id,
        notificationId: notification.id,
        rating: 'useful',
      }),
    ).rejects.toThrow()
  })
})
