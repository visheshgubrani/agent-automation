import type { gmail_v1 } from '@googleapis/gmail'
import { describe, expect, it } from 'vitest'
import {
  decodeBase64Url,
  decodeMimeWords,
  isExcludedMessage,
  MESSAGE_CLEANER_VERSION,
  parseAddressList,
  parseGmailMessage,
} from '../src/mail/mime.js'

const b64 = (value: string | Buffer): string => Buffer.from(value).toString('base64url')

function message(overrides: Partial<gmail_v1.Schema$Message> = {}): gmail_v1.Schema$Message {
  return {
    id: 'gmail-1',
    threadId: 'thread-1',
    internalDate: String(new Date('2026-10-20T10:00:00Z').getTime()),
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Example Bank <Alerts@Example.test>' },
        { name: 'To', value: 'Me <me@example.test>, Other <other@example.test>' },
        { name: 'Cc', value: 'cc@example.test' },
        { name: 'Subject', value: '=?UTF-8?B?QWNjb3VudCBkZWJpdCDinJM=?=' },
        { name: 'Message-ID', value: '<Case-1@Example.test>' },
        { name: 'Date', value: 'Mon, 20 Oct 2026 10:00:00 +0000' },
        { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
      ],
      body: { data: b64('Your account was debited.\n\nAmount: 10.00') },
    },
    ...overrides,
  }
}

describe('MIME decoding', () => {
  it('decodes B/Q encoded words and charset content', () => {
    expect(decodeMimeWords('=?UTF-8?B?QWNjb3VudCBkZWJpdA==?=')).toBe('Account debit')
    expect(decodeMimeWords('=?UTF-8?Q?Hello_=E2=9C=93?=')).toBe('Hello ✓')
    expect(decodeBase64Url(b64(Buffer.from([0x48, 0xe9])), 'iso-8859-1')).toBe('Hé')
  })

  it('parses quoted names, angle addresses, groups of addresses, and dedupes', () => {
    expect(parseAddressList('"Doe, John" <john@example.test>, jane@example.test')).toEqual([
      { name: 'Doe, John', email: 'john@example.test' },
      { name: null, email: 'jane@example.test' },
    ])
    expect(parseAddressList('John <JOHN@example.test>, John <john@example.test>, invalid')).toEqual(
      [{ name: 'John', email: 'john@example.test' }],
    )
    expect(parseAddressList('')).toEqual([])
  })

  it('marks spam/trash/draft/sent as excluded but keeps ordinary mail', () => {
    expect(isExcludedMessage(['INBOX'])).toBe(false)
    expect(isExcludedMessage(['INBOX', 'CATEGORY_PROMOTIONS'])).toBe(false)
    expect(isExcludedMessage(['UNREAD'])).toBe(false) // archived/read mail has no INBOX
    expect(isExcludedMessage(['CATEGORY_PERSONAL'])).toBe(false)
    expect(isExcludedMessage(['SPAM'])).toBe(true)
    expect(isExcludedMessage(['TRASH'])).toBe(true)
    expect(isExcludedMessage(['DRAFT'])).toBe(true)
    expect(isExcludedMessage(['SENT'])).toBe(true)
  })
})

describe('Gmail message parsing', () => {
  it('normalizes headers, addresses, Message-ID, labels, and separate raw/clean text', () => {
    const parsed = parseGmailMessage(message())
    if (!parsed) throw new Error('expected a parsed message')

    expect(parsed.providerMessageId).toBe('gmail-1')
    expect(parsed.providerThreadId).toBe('thread-1')
    expect(parsed.rfcMessageId).toBe('Case-1@Example.test')
    expect(parsed.fromEmail).toBe('alerts@example.test')
    expect(parsed.fromName).toBe('Example Bank')
    expect(parsed.toEmails).toEqual(['me@example.test', 'other@example.test'])
    expect(parsed.ccEmails).toEqual(['cc@example.test'])
    expect(parsed.subject).toBe('Account debit ✓')
    expect(parsed.providerLabels).toEqual(['INBOX', 'UNREAD'])
    expect(parsed.rawContentType).toBe('text/plain')
    expect(parsed.rawText).toContain('Your account was debited')
    expect(parsed.cleanText).toContain('Amount: 10.00')
    expect(parsed.cleanerVersion).toBe(MESSAGE_CLEANER_VERSION)
    expect(parsed.headers.from).toBe('Example Bank <Alerts@Example.test>')
    expect(parsed.headers['message-id']).toBe('<Case-1@Example.test>')
    expect(parsed.receivedAt.toISOString()).toBe('2026-10-20T10:00:00.000Z')
  })

  it('prefers a non-empty plain part in multipart/alternative', () => {
    const parsed = parseGmailMessage(
      message({
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'Subject', value: 'Alternative' }],
          parts: [
            {
              mimeType: 'text/plain',
              headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
              body: { data: b64('Plain version') },
            },
            {
              mimeType: 'text/html',
              headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
              body: { data: b64('<p>HTML version</p>') },
            },
          ],
        },
      }),
    )
    if (!parsed) throw new Error('expected a parsed message')
    expect(parsed.rawContentType).toBe('text/plain')
    expect(parsed.rawText).toBe('Plain version')
    expect(parsed.cleanText).toBe('Plain version')
  })

  it('cleans HTML-only bodies and drops scripts/tags', () => {
    const parsed = parseGmailMessage(
      message({
        payload: {
          mimeType: 'text/html',
          headers: [{ name: 'Subject', value: 'HTML mail' }],
          body: {
            data: b64(
              '<html><head><style>.x{color:red}</style></head><body><p>Hello <b>there</b></p><script>steal()</script><a href="https://evil.test">link</a></body></html>',
            ),
          },
        },
      }),
    )
    if (!parsed) throw new Error('expected a parsed message')
    expect(parsed.rawContentType).toBe('text/html')
    expect(parsed.rawText).toContain('<b>there</b>')
    expect(parsed.cleanText).toContain('Hello there')
    expect(parsed.cleanText).not.toContain('steal')
    expect(parsed.cleanText).not.toContain('<b>')
  })

  it('collects attachment metadata without using attachment content as the body', () => {
    const parsed = parseGmailMessage(
      message({
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: 'With attachment' }],
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: b64('Actual body') },
            },
            {
              mimeType: 'text/plain',
              filename: 'notes.txt',
              headers: [{ name: 'Content-Disposition', value: 'attachment; filename="notes.txt"' }],
              body: { data: b64('ATTACHMENT SHOULD NOT BE BODY'), size: 123 },
            },
            {
              mimeType: 'application/pdf',
              filename: 'invoice.pdf',
              headers: [
                { name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' },
              ],
              body: { attachmentId: 'attachment-1', size: 4_000 },
            },
          ],
        },
      }),
    )
    if (!parsed) throw new Error('expected a parsed message')
    expect(parsed.rawText).toBe('Actual body')
    expect(parsed.cleanText).toBe('Actual body')
    expect(parsed.headers.__attachments).toEqual([
      { filename: 'notes.txt', mimeType: 'text/plain', size: 123 },
      { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 4_000 },
    ])
  })

  it('handles missing ids and bodies without throwing', () => {
    expect(parseGmailMessage({ payload: { mimeType: 'text/plain' } })).toBeNull()

    const parsed = parseGmailMessage({
      id: 'empty',
      labelIds: ['INBOX'],
      payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'No body' }] },
    })
    if (!parsed) throw new Error('expected a parsed message')
    expect(parsed.rawText).toBe('')
    expect(parsed.cleanText).toBe('')
    expect(parsed.rawContentType).toBe('text/plain')
    expect(parsed.subject).toBe('No body')
    expect(parsed.fromEmail).toBe('')
  })
})
