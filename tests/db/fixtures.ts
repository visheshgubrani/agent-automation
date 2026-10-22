import {
  accounts,
  approvals,
  classificationFeedback,
  emailClassifications,
  mailboxSyncState,
  mailRules,
  messages,
  notificationOutbox,
  runs,
  telegramChats,
  userSettings,
} from '../../src/db/schema/index.js'
import { db } from './helpers.js'

let seq = 0
const next = () => ++seq

function firstRow<T>(rows: T[]): T {
  const [row] = rows
  if (!row) throw new Error('expected an inserted row')
  return row
}

export async function createAccount(
  overrides: Partial<typeof accounts.$inferInsert> = {},
): Promise<typeof accounts.$inferSelect> {
  return firstRow(
    await db
      .insert(accounts)
      .values({
        provider: 'gmail',
        emailAddress: `inbox-${next()}@example.test`,
        ...overrides,
      })
      .returning(),
  )
}

export async function createRun(
  overrides: Partial<typeof runs.$inferInsert> = {},
): Promise<typeof runs.$inferSelect> {
  return firstRow(
    await db
      .insert(runs)
      .values({ kind: 'mail_triage', trigger: 'manual', ...overrides })
      .returning(),
  )
}

export async function createMailboxSyncState(
  accountId: string,
  overrides: Partial<typeof mailboxSyncState.$inferInsert> = {},
): Promise<typeof mailboxSyncState.$inferSelect> {
  return firstRow(
    await db
      .insert(mailboxSyncState)
      .values({ accountId, ...overrides })
      .returning(),
  )
}

export async function createMessage(
  accountId: string,
  overrides: Partial<typeof messages.$inferInsert> = {},
): Promise<typeof messages.$inferSelect> {
  const n = next()
  return firstRow(
    await db
      .insert(messages)
      .values({
        accountId,
        providerMessageId: `gmail-${n}`,
        rfcMessageId: `<message-${n}@example.test>`,
        fromEmail: 'sender@example.test',
        subject: `Subject ${n}`,
        receivedAt: new Date(),
        rawText: `<p>raw ${n}</p>`,
        cleanText: `clean body ${n}`,
        ...overrides,
      })
      .returning(),
  )
}

export async function createClassification(
  messageId: string,
  runId: string,
  overrides: Partial<typeof emailClassifications.$inferInsert> = {},
): Promise<typeof emailClassifications.$inferSelect> {
  return firstRow(
    await db
      .insert(emailClassifications)
      .values({
        messageId,
        runId,
        category: 'needs_reply',
        confidence: '0.900',
        model: 'test-model',
        promptVersion: 'prompt-v1',
        classifierVersion: 'classifier-v1',
        ...overrides,
      })
      .returning(),
  )
}

export async function createUserSettings(
  overrides: Partial<typeof userSettings.$inferInsert> = {},
): Promise<typeof userSettings.$inferSelect> {
  return firstRow(
    await db
      .insert(userSettings)
      .values({ id: 1, ...overrides })
      .returning(),
  )
}

export async function createMailRule(
  overrides: Partial<typeof mailRules.$inferInsert> = {},
): Promise<typeof mailRules.$inferSelect> {
  return firstRow(
    await db
      .insert(mailRules)
      .values({
        action: 'notify',
        matchType: 'sender',
        matchValue: 'sender@example.test',
        ...overrides,
      })
      .returning(),
  )
}

export async function createFeedback(
  classificationId: string,
  overrides: Partial<typeof classificationFeedback.$inferInsert> = {},
): Promise<typeof classificationFeedback.$inferSelect> {
  return firstRow(
    await db
      .insert(classificationFeedback)
      .values({ classificationId, rating: 'useful', ...overrides })
      .returning(),
  )
}

export async function createApproval(
  runId: string,
  overrides: Partial<typeof approvals.$inferInsert> = {},
): Promise<typeof approvals.$inferSelect> {
  return firstRow(
    await db
      .insert(approvals)
      .values({
        runId,
        toolName: 'send_email',
        riskTier: 'send',
        summary: 'Send an email',
        payload: { to: 'lead@example.test', body: 'hello' },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        ...overrides,
      })
      .returning(),
  )
}

export async function createEmailNotification(
  classificationId: string,
  overrides: Partial<typeof notificationOutbox.$inferInsert> = {},
): Promise<typeof notificationOutbox.$inferSelect> {
  return firstRow(
    await db
      .insert(notificationOutbox)
      .values({
        kind: 'email_triage',
        dedupeKey: `email_triage:classification:${classificationId}`,
        classificationId,
        body: 'New email',
        ...overrides,
      })
      .returning(),
  )
}

export async function createSystemNotification(
  overrides: Partial<typeof notificationOutbox.$inferInsert> = {},
): Promise<typeof notificationOutbox.$inferSelect> {
  return firstRow(
    await db
      .insert(notificationOutbox)
      .values({
        kind: 'system',
        dedupeKey: `system:${next()}`,
        body: 'System message',
        ...overrides,
      })
      .returning(),
  )
}

export async function createTelegramChat(
  overrides: Partial<typeof telegramChats.$inferInsert> = {},
): Promise<typeof telegramChats.$inferSelect> {
  return firstRow(
    await db
      .insert(telegramChats)
      .values({ telegramChatId: 100_000 + next(), ...overrides })
      .returning(),
  )
}
