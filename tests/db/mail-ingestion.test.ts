import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { messages } from '../../src/db/schema/index.js'
import {
  loadStoredMessageLabels,
  updateMessageLabels,
  upsertParsedMessage,
  upsertParsedMessages,
} from '../../src/mail/ingestion.js'
import { type ParsedGmailMessage, parseGmailMessage } from '../../src/mail/mime.js'
import { createAccount } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const b64 = (value: string): string => Buffer.from(value).toString('base64url')

beforeEach(truncateAllTables)
afterAll(closeTestDb)

function parsed(overrides: Partial<ParsedGmailMessage> = {}): ParsedGmailMessage {
  return {
    providerMessageId: 'gmail-message-1',
    providerThreadId: 'thread-1',
    rfcMessageId: 'msg-1@example.test',
    fromEmail: 'sender@example.test',
    fromName: 'Sender',
    toEmails: ['inbox@example.test'],
    ccEmails: [],
    subject: 'Subject',
    receivedAt: new Date('2026-10-20T10:00:00Z'),
    providerLabels: ['INBOX'],
    rawText: '<p>Raw body</p>',
    rawContentType: 'text/html',
    cleanText: 'Raw body',
    cleanerVersion: 1,
    headers: { subject: 'Subject' },
    ...overrides,
  }
}

describe('message ingestion', () => {
  it('stores raw and clean text separately with provider metadata and a pending status', async () => {
    const account = await createAccount()
    const row = await upsertParsedMessage(db, account.id, parsed())
    if (!row) throw new Error('expected an ingested row')

    const [stored] = await db.select().from(messages).where(eq(messages.id, row.id))
    expect(stored).toMatchObject({
      accountId: account.id,
      providerMessageId: 'gmail-message-1',
      providerThreadId: 'thread-1',
      rfcMessageId: 'msg-1@example.test',
      fromEmail: 'sender@example.test',
      fromName: 'Sender',
      toEmails: ['inbox@example.test'],
      subject: 'Subject',
      providerLabels: ['INBOX'],
      rawText: '<p>Raw body</p>',
      rawContentType: 'text/html',
      cleanText: 'Raw body',
      cleanerVersion: 1,
      triageStatus: 'pending',
      triageAttempts: 0,
      headers: { subject: 'Subject' },
    })
  })

  it('refreshes labels on replay without resetting classification progress or body text', async () => {
    const account = await createAccount()
    const first = await upsertParsedMessage(db, account.id, parsed())
    if (!first) throw new Error('expected an ingested row')
    await db
      .update(messages)
      .set({ triageStatus: 'classified', triageAttempts: 1, cleanText: 'classified text' })
      .where(eq(messages.id, first.id))

    await upsertParsedMessage(
      db,
      account.id,
      parsed({ providerLabels: ['INBOX', 'UNREAD'], rawText: 'different raw' }),
    )

    const [stored] = await db.select().from(messages).where(eq(messages.id, first.id))
    expect(stored?.providerLabels).toEqual(['INBOX', 'UNREAD'])
    expect(stored?.triageStatus).toBe('classified')
    expect(stored?.triageAttempts).toBe(1)
    expect(stored?.cleanText).toBe('classified text')
    expect(stored?.rawText).toBe('<p>Raw body</p>')
  })

  it('skips excluded messages and counts only upserted rows', async () => {
    const account = await createAccount()
    const result = await upsertParsedMessage(
      db,
      account.id,
      parsed({ providerMessageId: 'spam-1', providerLabels: ['SPAM'] }),
    )
    expect(result).toBeUndefined()
    expect(await db.select().from(messages)).toHaveLength(0)

    const count = await upsertParsedMessages(db, account.id, [
      parsed({ providerMessageId: 'a' }),
      parsed({ providerMessageId: 'b', providerLabels: ['TRASH'] }),
      parsed({ providerMessageId: 'c' }),
    ])
    expect(count).toBe(2)
    expect(await db.select().from(messages)).toHaveLength(2)
  })

  it('loads and updates stored labels for history changes', async () => {
    const account = await createAccount()
    const row = await upsertParsedMessage(db, account.id, parsed())
    if (!row) throw new Error('expected an ingested row')

    const [labels] = await loadStoredMessageLabels(db, account.id, ['gmail-message-1'])
    expect(labels?.providerLabels).toEqual(['INBOX'])

    await updateMessageLabels(db, row.id, ['UNREAD', 'INBOX', 'UNREAD'], new Date())
    const [updated] = await db.select().from(messages).where(eq(messages.id, row.id))
    expect(updated?.providerLabels).toEqual(['INBOX', 'UNREAD'])
  })

  it('parses and stores an HTML body with the cleaner', async () => {
    const account = await createAccount()
    const gmail = {
      id: 'parsed-html',
      internalDate: String(Date.now()),
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'text/html',
        headers: [{ name: 'Subject', value: 'HTML' }],
        body: { data: b64('<p>Hello <b>there</b></p>') },
      },
    }
    const message = parseGmailMessage(gmail)
    if (!message) throw new Error('expected a parsed message')
    const row = await upsertParsedMessage(db, account.id, message)
    if (!row) throw new Error('expected an ingested row')

    const [stored] = await db.select().from(messages).where(eq(messages.id, row.id))
    expect(stored?.rawText).toContain('<p>Hello')
    expect(stored?.cleanText).toBe('Hello there')
  })
})
