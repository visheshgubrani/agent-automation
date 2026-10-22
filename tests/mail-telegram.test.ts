import { and, eq, isNull } from 'drizzle-orm'
import type { Update } from 'grammy/types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  classificationFeedback,
  emailClassifications,
  mailRules,
  notificationOutbox,
  telegramMessages,
  telegramUpdates,
} from '../src/db/schema/index.js'
import { handleTelegramUpdate } from '../src/telegram/updates.js'
import {
  createAccount,
  createClassification,
  createEmailNotification,
  createMailboxSyncState,
  createMessage,
  createRun,
} from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

const CHAT_ID = 42
const UNAUTHORIZED_CHAT_ID = 999
const BOUNDARY = new Date('2026-10-22T10:00:00Z')
const AFTER_BOUNDARY = new Date('2026-10-22T11:00:00Z')

let updateIdSeq = 0
let accountSeq = 0

function messageUpdate(text: string, messageId = 500): Update {
  updateIdSeq += 1
  return {
    update_id: updateIdSeq,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: 'private', first_name: 'Tester', username: 'tester' },
      from: { id: CHAT_ID, is_bot: false, first_name: 'Tester', username: 'tester' },
      text,
    },
  } as unknown as Update
}

function callbackUpdate(data: string, messageId: number, chatId = CHAT_ID): Update {
  updateIdSeq += 1
  return {
    update_id: updateIdSeq,
    callback_query: {
      id: `callback-${updateIdSeq}`,
      from: { id: chatId, is_bot: false, first_name: 'Tester', username: 'tester' },
      chat_instance: 'chat-instance',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private', first_name: 'Tester' },
        text: 'button message',
      },
    },
  } as unknown as Update
}

interface ReplyRecord {
  id: number
  text: string
  buttons?: unknown
}

function fakeTransport() {
  const replies: ReplyRecord[] = []
  const edits: { messageId: number; text: string; buttons?: unknown }[] = []
  const answers: (string | undefined)[] = []
  let nextMessageId = 1_000

  return {
    replies,
    edits,
    answers,
    reply: async (text: string, options?: { buttons?: unknown }) => {
      nextMessageId += 1
      replies.push({
        id: nextMessageId,
        text,
        ...(options?.buttons ? { buttons: options.buttons } : {}),
      })
      return nextMessageId
    },
    editMessage: async (messageId: number, text: string, options?: { buttons?: unknown }) => {
      edits.push({ messageId, text, ...(options?.buttons ? { buttons: options.buttons } : {}) })
    },
    answerCallback: async (text?: string) => {
      answers.push(text)
    },
  }
}

async function sendCommand(text: string, transport: ReturnType<typeof fakeTransport>) {
  await handleTelegramUpdate(messageUpdate(text), {
    chatId: CHAT_ID,
    reply: transport.reply,
    editMessage: transport.editMessage,
    answerCallback: transport.answerCallback,
  })
}

async function sendCallback(
  data: string,
  messageId: number,
  transport: ReturnType<typeof fakeTransport>,
  chatId = CHAT_ID,
) {
  await handleTelegramUpdate(callbackUpdate(data, messageId, chatId), {
    chatId: CHAT_ID,
    reply: transport.reply,
    editMessage: transport.editMessage,
    answerCallback: transport.answerCallback,
  })
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

async function seedIgnoredMessage(
  subject: string,
  receivedAt = AFTER_BOUNDARY,
  emailAddress?: string,
) {
  const account = await createAccount({
    emailAddress: emailAddress ?? `work-${++accountSeq}@example.test`,
  })
  await createMailboxSyncState(account.id, { notificationBoundaryAt: BOUNDARY })
  const run = await createRun()
  const message = await createMessage(account.id, {
    subject,
    fromEmail: 'sender@example.test',
    fromName: 'Sender',
    receivedAt,
    cleanText: `${subject} body`,
  })
  const classification = await createClassification(message.id, run.id, {
    shouldNotify: false,
    summary: `${subject} summary`,
  })
  return { account, run, message, classification }
}

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('mail review commands', () => {
  it('paginates ignored mail and edits the same message on the next page', async () => {
    for (let index = 0; index < 6; index += 1) {
      await seedIgnoredMessage(`Ignored ${index}`, new Date(`2026-10-22T0${index}:00:00Z`))
    }
    const transport = fakeTransport()

    await sendCommand('/mail ignored', transport)
    expect(transport.replies).toHaveLength(1)
    expect(transport.replies[0]?.text).toContain('Ignored mail — page 1')
    expect(transport.replies[0]?.text).toContain('Ignored 5')
    expect(transport.replies[0]?.text).not.toContain('Ignored 0')
    expect(JSON.stringify(transport.replies[0]?.buttons)).toContain('mail:useful:')

    const reviewMessageId = transport.replies[0]?.id
    if (!reviewMessageId) throw new Error('expected a review reply')
    const [stored] = await db
      .select()
      .from(telegramMessages)
      .where(
        and(
          eq(telegramMessages.telegramMessageId, reviewMessageId),
          eq(telegramMessages.direction, 'outbound'),
        ),
      )
    const payload = stored?.payload as {
      mailReview?: { classificationIds?: string[]; page?: number }
    }
    expect(payload.mailReview?.page).toBe(0)
    expect(payload.mailReview?.classificationIds).toHaveLength(5)

    await sendCallback('mail:ignored_page:1', reviewMessageId, transport)
    expect(transport.edits).toHaveLength(1)
    expect(transport.edits[0]?.messageId).toBe(reviewMessageId)
    expect(transport.edits[0]?.text).toContain('Ignored mail — page 2')
    expect(transport.edits[0]?.text).toContain('Ignored 0')
    expect(transport.answers.at(-1)).toBeUndefined()
  })

  it('searches stored mail including ignored mail', async () => {
    await seedIgnoredMessage('Debit alert')
    const transport = fakeTransport()

    await sendCommand('/mail search debit', transport)
    expect(transport.replies[0]?.text).toContain('Search: "debit"')
    expect(transport.replies[0]?.text).toContain('Ignored')
    expect(transport.replies[0]?.text).toContain('Debit alert')
    expect(JSON.stringify(transport.replies[0]?.buttons)).toContain('mail:not_important:')
  })

  it('rejects a review button after the stored page no longer contains it', async () => {
    let newest: Awaited<ReturnType<typeof seedIgnoredMessage>> | undefined
    for (let index = 0; index < 6; index += 1) {
      const seeded = await seedIgnoredMessage(
        `Ignored ${index}`,
        new Date(`2026-10-22T0${index}:00:00Z`),
      )
      if (index === 5) newest = seeded
    }
    if (!newest) throw new Error('expected the newest seeded message')
    const transport = fakeTransport()
    await sendCommand('/mail ignored', transport)
    const reviewMessageId = transport.replies[0]?.id
    if (!reviewMessageId) throw new Error('expected a review reply')

    await sendCallback('mail:ignored_page:1', reviewMessageId, transport)
    await sendCallback(`mail:important:${newest.classification.id}`, reviewMessageId, transport)

    expect(transport.answers.at(-1)).toContain('out of date')
    expect(await currentClassification(newest.message.id)).toMatchObject({
      id: newest.classification.id,
      shouldNotify: false,
    })
  })
})

describe('mail feedback callbacks', () => {
  it('marks ignored mail important without a notification and is idempotent', async () => {
    const { message, classification } = await seedIgnoredMessage('Client request')
    const transport = fakeTransport()
    await sendCommand('/mail ignored', transport)
    const reviewMessageId = transport.replies[0]?.id
    if (!reviewMessageId) throw new Error('expected a review reply')

    await sendCallback(`mail:important:${classification.id}`, reviewMessageId, transport)
    expect(transport.answers[0]).toContain('Marked important')
    expect(transport.answers[0]).toContain('alert queued')

    const current = await currentClassification(message.id)
    expect(current).toMatchObject({ decisionSource: 'correction', shouldNotify: true })
    const [feedback] = await db
      .select()
      .from(classificationFeedback)
      .where(eq(classificationFeedback.classificationId, classification.id))
    expect(feedback).toMatchObject({
      rating: 'useful',
      reason: 'missed_important',
      notificationId: null,
    })
    const alerts = await db.select().from(notificationOutbox)
    expect(alerts).toHaveLength(1)

    await sendCallback(`mail:important:${classification.id}`, reviewMessageId, transport)
    expect(transport.answers[1]).toContain('already exists')
    expect(await db.select().from(notificationOutbox)).toHaveLength(1)
    expect((await currentClassification(message.id))?.id).toBe(current?.id)
  })

  it('links feedback to the sent alert and rejects a mismatched notification', async () => {
    const account = await createAccount()
    const run = await createRun()
    const message = await createMessage(account.id, { receivedAt: AFTER_BOUNDARY })
    const otherMessage = await createMessage(account.id, { receivedAt: AFTER_BOUNDARY })
    const classification = await createClassification(message.id, run.id, { shouldNotify: true })
    const otherClassification = await createClassification(otherMessage.id, run.id, {
      shouldNotify: true,
    })
    const sentAt = new Date()
    const normalizedRfc = message.rfcMessageId?.replace(/^<|>$/g, '') ?? message.id
    const sent = await createEmailNotification(classification.id, {
      dedupeKey: `email_triage:rfc:${normalizedRfc}`,
      status: 'sent',
      sentAt,
      telegramMessageId: 777,
    })
    const transport = fakeTransport()

    await sendCallback(`mail:useful:${classification.id}`, 777, transport)
    expect(transport.answers[0]).toContain('already delivered')
    const [feedback] = await db
      .select()
      .from(classificationFeedback)
      .where(eq(classificationFeedback.classificationId, classification.id))
    expect(feedback?.notificationId).toBe(sent.id)

    await sendCallback(`mail:useful:${otherClassification.id}`, 777, transport)
    expect(transport.answers[1]).toContain('out of date')
    expect(
      await db
        .select()
        .from(classificationFeedback)
        .where(eq(classificationFeedback.classificationId, otherClassification.id)),
    ).toHaveLength(0)
  })

  it('cancels an unsent alert from a review result without linking feedback', async () => {
    const account = await createAccount()
    await createMailboxSyncState(account.id, { notificationBoundaryAt: BOUNDARY })
    const run = await createRun()
    const message = await createMessage(account.id, {
      rfcMessageId: '<pending@example.test>',
      subject: 'Debit alert',
      receivedAt: AFTER_BOUNDARY,
    })
    const classification = await createClassification(message.id, run.id, { shouldNotify: true })
    const pending = await createEmailNotification(classification.id, {
      dedupeKey: 'email_triage:rfc:pending@example.test',
      status: 'pending',
    })
    const transport = fakeTransport()
    await sendCommand('/mail search debit', transport)
    const reviewMessageId = transport.replies[0]?.id
    if (!reviewMessageId) throw new Error('expected a review reply')

    await sendCallback(`mail:not_important:${classification.id}`, reviewMessageId, transport)
    expect(transport.answers[0]).toContain('cancelled 1 unsent alert')
    const [feedback] = await db
      .select()
      .from(classificationFeedback)
      .where(eq(classificationFeedback.classificationId, classification.id))
    expect(feedback?.notificationId).toBeNull()
    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, pending.id))
    expect(row?.status).toBe('cancelled')
  })
})

describe('mail rule controls', () => {
  it('previews, saves once, and disables a rule from Telegram', async () => {
    const { classification } = await seedIgnoredMessage('Newsletter')
    const transport = fakeTransport()
    await sendCommand('/mail ignored', transport)
    const reviewMessageId = transport.replies[0]?.id
    if (!reviewMessageId) throw new Error('expected a review reply')

    await sendCallback(`mail:rule:${classification.id}`, reviewMessageId, transport)
    expect(transport.replies[1]?.text).toContain('Create rule (not saved yet)')
    expect(transport.replies[1]?.text).toContain('Action: Ignore')
    expect(transport.replies[1]?.text).toContain('Match: sender sender@example.test')
    expect(JSON.stringify(transport.replies[1]?.buttons)).toContain('mail:rule_save')

    const previewMessageId = transport.replies[1]?.id
    if (!previewMessageId) throw new Error('expected a rule preview')
    await sendCallback('mail:rule_save', previewMessageId, transport)
    expect(transport.answers.at(-1)).toBe('Rule saved.')
    expect(transport.edits.at(-1)?.text).toContain('Rule saved.')

    const rules = await db.select().from(mailRules)
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      action: 'ignore',
      matchType: 'sender',
      matchValue: 'sender@example.test',
      accountId: null,
    })

    await sendCallback('mail:rule_save', previewMessageId, transport)
    expect(transport.answers.at(-1)).toBe('Rule already saved.')
    expect(await db.select().from(mailRules)).toHaveLength(1)

    await sendCallback('mail:rule_action', previewMessageId, transport)
    expect(transport.answers.at(-1)).toBe('Rule already saved.')

    await sendCommand('/mail rules', transport)
    const listMessageId = transport.replies.at(-1)?.id
    if (!listMessageId) throw new Error('expected a rules list')
    const ruleId = rules[0]?.id
    if (!ruleId) throw new Error('expected a rule id')
    await sendCallback(`mail:rule_disable:${ruleId}`, listMessageId, transport)
    expect(transport.answers.at(-1)).toBe('Rule disabled.')
    const [disabled] = await db.select().from(mailRules).where(eq(mailRules.id, ruleId))
    expect(disabled?.active).toBe(false)
    expect(transport.edits.at(-1)?.text).toContain('No active rules.')
  })

  it('creates a scoped rule with a subject condition from the command', async () => {
    const account = await createAccount({ emailAddress: 'work@example.test' })
    const transport = fakeTransport()

    await sendCommand(
      '/mail rules add notify domain example.test subject: invoice account: work@example.test',
      transport,
    )
    expect(transport.replies[0]?.text).toContain('Create rule (not saved yet)')
    expect(transport.replies[0]?.text).toContain('Match: domain example.test')
    expect(transport.replies[0]?.text).toContain('Subject contains: invoice')
    expect(transport.replies[0]?.text).toContain('Scope: Only work@example.test')

    const previewMessageId = transport.replies[0]?.id
    if (!previewMessageId) throw new Error('expected a rule preview')
    await sendCallback('mail:rule_save', previewMessageId, transport)
    const [rule] = await db.select().from(mailRules)
    expect(rule).toMatchObject({
      action: 'notify',
      matchType: 'domain',
      matchValue: 'example.test',
      subjectContains: 'invoice',
      accountId: account.id,
      active: true,
    })
  })

  it('toggles action, match type, and account scope before saving', async () => {
    const { account, classification } = await seedIgnoredMessage('Promotion')
    const transport = fakeTransport()
    await sendCommand('/mail ignored', transport)
    const reviewMessageId = transport.replies[0]?.id
    if (!reviewMessageId) throw new Error('expected a review reply')

    await sendCallback(`mail:create_rule:${classification.id}`, reviewMessageId, transport)
    const previewMessageId = transport.replies[1]?.id
    if (!previewMessageId) throw new Error('expected a rule preview')
    expect(transport.replies[1]?.text).toContain('Action: Ignore')

    await sendCallback('mail:rule_action', previewMessageId, transport)
    expect(transport.edits.at(-1)?.text).toContain('Action: Notify')

    await sendCallback('mail:rule_match', previewMessageId, transport)
    expect(transport.edits.at(-1)?.text).toContain('Match: domain example.test')

    await sendCallback('mail:rule_scope', previewMessageId, transport)
    expect(transport.edits.at(-1)?.text).toContain(`Scope: Only ${account.emailAddress}`)

    await sendCallback('mail:rule_save', previewMessageId, transport)
    const [rule] = await db.select().from(mailRules)
    expect(rule).toMatchObject({
      action: 'notify',
      matchType: 'domain',
      matchValue: 'example.test',
      accountId: account.id,
    })
  })
})

describe('mail status and callback safety', () => {
  it('reports account health, backlog, spend, and outbox state', async () => {
    const account = await createAccount({ emailAddress: 'work@example.test' })
    await createMailboxSyncState(account.id, {
      notificationBoundaryAt: BOUNDARY,
      consecutiveFailures: 2,
      lastError: 'temporary sync failure',
    })
    await createMessage(account.id, { triageStatus: 'pending' })
    const run = await createRun()
    const failedMessage = await createMessage(account.id)
    const failedClassification = await createClassification(failedMessage.id, run.id)
    await createEmailNotification(failedClassification.id, {
      dedupeKey: 'email_triage:status-failed',
      status: 'failed',
      lastError: 'send failed',
    })

    const transport = fakeTransport()
    await sendCommand('/mail status', transport)
    const text = transport.replies[0]?.text ?? ''
    expect(text).toContain('Mail status')
    expect(text).toContain('work@example.test')
    expect(text).toContain('2 consecutive failure(s)')
    expect(text).toContain('Backlog:')
    expect(text).toContain('Spend ')
    expect(text).toContain('Asia/Kolkata')
    expect(text).toContain('Outbox:')
    expect(text).toContain('1 failed')
  })

  it('acknowledges unknown callbacks and drops unauthorized chats', async () => {
    const transport = fakeTransport()
    await sendCallback('mail:unknown', 1, transport)
    expect(transport.answers).toEqual(['Unknown mail action.'])

    const unauthorized = fakeTransport()
    await sendCallback(
      'mail:important:11111111-2222-4333-8444-555555555555',
      1,
      unauthorized,
      UNAUTHORIZED_CHAT_ID,
    )
    expect(unauthorized.answers).toEqual([])
    expect(await db.select().from(telegramUpdates)).toHaveLength(1) // only the authorized callback
  })
})
