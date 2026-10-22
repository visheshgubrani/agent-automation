import type { gmail_v1 } from '@googleapis/gmail'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mailboxSyncState, messages } from '../src/db/schema/index.js'
import { upsertParsedMessage } from '../src/mail/ingestion.js'
import { parseGmailMessage } from '../src/mail/mime.js'
import {
  GMAIL_QUERY,
  type GmailSyncApi,
  isHistoryExpiredError,
  maxHistoryId,
  syncAccount,
} from '../src/mail/sync.js'
import { createAccount } from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

const b64 = (value: string): string => Buffer.from(value).toString('base64url')

function notFound(): Error & { response: { status: number } } {
  return Object.assign(new Error('not found'), { response: { status: 404 } })
}

function serverError(): Error & { response: { status: number } } {
  return Object.assign(new Error('server error'), { response: { status: 500 } })
}

function gmailMessage(
  id: string,
  text = `Body ${id}`,
  labels = ['INBOX'],
): gmail_v1.Schema$Message {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(new Date('2026-10-20T10:00:00Z').getTime()),
    labelIds: labels,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'sender@example.test' },
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'Message-ID', value: `<${id}@example.test>` },
      ],
      body: { data: b64(text) },
    },
  }
}

function emptyPage(historyId = '100'): { history: gmail_v1.Schema$History[]; historyId: string } {
  return { history: [], historyId }
}

class FakeGmailApi {
  profileHistoryId = '100'
  callOrder: string[] = []
  profileCalls = 0
  listCalls: Array<Record<string, unknown>> = []
  getCalls: string[] = []
  historyCalls: Array<Record<string, unknown>> = []
  messagePages: Array<{ messages?: Array<{ id: string }>; nextPageToken?: string }> = []
  historyPages: Array<{
    history?: gmail_v1.Schema$History[]
    nextPageToken?: string
    historyId?: string
  }> = []
  messages = new Map<string, gmail_v1.Schema$Message>()
  listError: unknown
  historyError: unknown
  getErrors = new Map<string, unknown>()

  users = {
    getProfile: async () => {
      this.callOrder.push('profile')
      this.profileCalls += 1
      return { data: { historyId: this.profileHistoryId } }
    },
    messages: {
      list: async (params: Record<string, unknown>) => {
        this.callOrder.push('list')
        this.listCalls.push(params)
        if (this.listError) throw this.listError
        return { data: this.messagePages.shift() ?? { messages: [] } }
      },
      get: async ({ id }: { id: string }) => {
        this.callOrder.push(`get:${id}`)
        this.getCalls.push(id)
        const error = this.getErrors.get(id)
        if (error) {
          this.getErrors.delete(id)
          throw error
        }
        const message = this.messages.get(id)
        if (!message) throw notFound()
        return { data: message }
      },
    },
    history: {
      list: async (params: Record<string, unknown>) => {
        this.callOrder.push('history')
        this.historyCalls.push(params)
        if (this.historyError) {
          const error = this.historyError
          this.historyError = undefined
          throw error
        }
        return { data: this.historyPages.shift() ?? emptyPage(this.profileHistoryId) }
      },
    },
  }
}

beforeEach(truncateAllTables)
afterAll(closeTestDb)

async function accountWithState(
  options: {
    historyId?: string | null
    initialComplete?: boolean
    boundary?: Date
    lastSuccessAt?: Date | null
    needsFullResync?: boolean
  } = {},
) {
  const boundary = options.boundary ?? new Date('2026-10-20T00:00:00Z')
  const account = await createAccount()
  await db.insert(mailboxSyncState).values({
    accountId: account.id,
    notificationBoundaryAt: boundary,
    historyId: options.historyId === undefined ? '100' : options.historyId,
    initialSyncCompletedAt: options.initialComplete === false ? null : new Date(),
    lastSuccessAt: options.lastSuccessAt === undefined ? new Date() : options.lastSuccessAt,
    needsFullResync: options.needsFullResync ?? false,
  })
  return account
}

describe('initial sync and checkpoint replay', () => {
  it('paces Gmail calls when a request delay is configured', async () => {
    const account = await createAccount()
    const api = new FakeGmailApi()
    api.messagePages = [{ messages: [{ id: 'paced-1' }] }]
    api.messages.set('paced-1', gmailMessage('paced-1'))

    const started = performance.now()
    const result = await syncAccount({
      db,
      accountId: account.id,
      api,
      now: new Date('2026-10-20T12:00:00Z'),
      requestDelayMs: 20,
    })
    const elapsed = performance.now() - started

    expect(result.counters.ingested).toBe(1)
    // profile + list + get + history = four paced calls.
    expect(elapsed).toBeGreaterThanOrEqual(60)
  })

  it('captures the checkpoint before backfill, ingests all pages, then replays arrivals', async () => {
    const account = await createAccount()
    await db.insert(mailboxSyncState).values({
      accountId: account.id,
      notificationBoundaryAt: new Date('2026-10-20T00:00:00Z'),
    })
    const api = new FakeGmailApi()
    api.profileHistoryId = '100'
    api.messagePages = [
      { messages: [{ id: 'm1' }], nextPageToken: 'p2' },
      { messages: [{ id: 'm2' }] },
    ]
    api.messages.set('m1', gmailMessage('m1'))
    api.messages.set('m2', gmailMessage('m2'))
    api.messages.set('m3', gmailMessage('m3'))
    api.historyPages = [
      {
        history: [{ id: '101', messagesAdded: [{ message: { id: 'm3' } }] }],
        historyId: '101',
      },
    ]

    const now = new Date('2026-10-21T00:00:00Z')
    const result = await syncAccount({
      db,
      accountId: account.id,
      api: api as unknown as GmailSyncApi,
      now,
    })

    expect(result.mode).toBe('initial')
    expect(result.historyId).toBe('101')
    expect(result.counters.fetched).toBe(3)
    expect(result.counters.ingested).toBe(3)
    expect(api.callOrder[0]).toBe('profile')
    expect(api.callOrder.indexOf('profile')).toBeLessThan(api.callOrder.indexOf('list'))
    expect(String(api.listCalls[0]?.q)).toContain('-in:spam')
    expect(String(api.listCalls[0]?.q)).toContain('-in:trash')
    expect(String(api.listCalls[0]?.q)).toContain('-in:drafts')
    expect(String(api.listCalls[0]?.q)).toContain('-in:sent')
    expect(String(api.listCalls[0]?.q)).toContain('after:')
    expect(api.historyCalls[0]?.startHistoryId).toBe('100')

    const [state] = await db.select().from(mailboxSyncState)
    expect(state).toMatchObject({
      historyId: '101',
      needsFullResync: false,
      consecutiveFailures: 0,
    })
    expect(state?.initialSyncCompletedAt).toBeInstanceOf(Date)
    expect(state?.notificationBoundaryAt?.toISOString()).toBe('2026-10-20T00:00:00.000Z')
    expect(await db.select().from(messages)).toHaveLength(3)
  })

  it('skips messages removed before retrieval and excluded labels without failing the sync', async () => {
    const account = await createAccount()
    const api = new FakeGmailApi()
    api.messagePages = [{ messages: [{ id: 'missing' }, { id: 'spam' }, { id: 'ok' }] }]
    api.messages.set('spam', gmailMessage('spam', 'spam body', ['SPAM']))
    api.messages.set('ok', gmailMessage('ok'))

    const result = await syncAccount({
      db,
      accountId: account.id,
      api: api as unknown as GmailSyncApi,
      now: new Date('2026-10-21T00:00:00Z'),
    })

    expect(result.mode).toBe('initial')
    expect(result.counters.fetched).toBe(2)
    expect(result.counters.skipped).toBe(2)
    expect(result.counters.ingested).toBe(1)
    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.providerMessageId).toBe('ok')
  })
})

describe('incremental history and labels', () => {
  it('commits each page cursor and replays an unprocessed page after a crash', async () => {
    const account = await accountWithState()
    const api = new FakeGmailApi()
    api.messages.set('m1', gmailMessage('m1'))
    api.messages.set('m2', gmailMessage('m2'))
    api.historyPages = [
      {
        history: [{ id: '101', messagesAdded: [{ message: { id: 'm1' } }] }],
        nextPageToken: 'p2',
        historyId: '105',
      },
      {
        history: [{ id: '103', messagesAdded: [{ message: { id: 'm2' } }] }],
        historyId: '105',
      },
    ]
    api.getErrors.set('m2', serverError())

    const now = new Date('2026-10-21T00:00:00Z')
    await expect(
      syncAccount({
        db,
        accountId: account.id,
        api: api as unknown as GmailSyncApi,
        now,
      }),
    ).rejects.toThrow('server error')

    const [afterCrash] = await db.select().from(mailboxSyncState)
    expect(afterCrash?.historyId).toBe('101')
    expect(api.historyCalls[0]?.startHistoryId).toBe('100')
    expect(api.historyCalls[1]?.startHistoryId).toBe('100')
    expect(api.historyCalls[1]?.pageToken).toBe('p2')
    expect(await db.select().from(messages)).toHaveLength(1)

    await db.update(mailboxSyncState).set({ backoffUntil: null })
    api.historyPages = [
      {
        history: [{ id: '103', messagesAdded: [{ message: { id: 'm2' } }] }],
        historyId: '105',
      },
    ]
    const recovered = await syncAccount({
      db,
      accountId: account.id,
      api: api as unknown as GmailSyncApi,
      now: new Date('2026-10-21T00:01:00Z'),
    })

    expect(recovered.historyId).toBe('105')
    const [state] = await db.select().from(mailboxSyncState)
    expect(state?.historyId).toBe('105')
    expect(await db.select().from(messages)).toHaveLength(2)
    expect(api.historyCalls.at(-1)?.startHistoryId).toBe('101')
  })

  it('applies label additions/removals and retains deleted message history', async () => {
    const account = await accountWithState()
    const api = new FakeGmailApi()
    const message = gmailMessage('m1')
    api.messages.set('m1', message)
    const parsed = parseGmailMessage(message)
    if (!parsed) throw new Error('expected parsed message')
    const stored = await upsertParsedMessage(db, account.id, parsed)
    if (!stored) throw new Error('expected stored message')

    api.historyPages = [
      {
        history: [
          {
            id: '101',
            labelsAdded: [{ message: { id: 'm1' }, labelIds: ['IMPORTANT'] }],
            labelsRemoved: [{ message: { id: 'm1' }, labelIds: ['INBOX'] }],
            messagesDeleted: [{ message: { id: 'm1' } }],
          },
        ],
        historyId: '101',
      },
    ]

    const result = await syncAccount({
      db,
      accountId: account.id,
      api: api as unknown as GmailSyncApi,
      now: new Date('2026-10-21T00:00:00Z'),
    })

    expect(result.counters.labelChanges).toBe(1)
    const [row] = await db.select().from(messages).where(eq(messages.id, stored.id))
    expect(row?.providerLabels).toEqual(['IMPORTANT'])
    expect(row?.cleanText).toBe('Body m1')
  })
})

describe('recovery and failure state', () => {
  it('recovers an expired history cursor by scanning since the last success, not just 7 days', async () => {
    const lastSuccess = new Date('2026-09-01T00:00:00Z')
    const account = await accountWithState({
      historyId: '50',
      lastSuccessAt: lastSuccess,
      boundary: new Date('2026-08-01T00:00:00Z'),
    })
    const api = new FakeGmailApi()
    api.profileHistoryId = '200'
    api.historyError = notFound()
    api.messages.set('old', gmailMessage('old'))
    api.messagePages = [{ messages: [{ id: 'old' }] }]

    const now = new Date('2026-10-21T00:00:00Z')
    const result = await syncAccount({
      db,
      accountId: account.id,
      api: api as unknown as GmailSyncApi,
      now,
    })

    expect(result.mode).toBe('recovery')
    expect(result.historyId).toBe('200')
    const expectedAfter = Math.floor((lastSuccess.getTime() - 60 * 60 * 1000) / 1000)
    expect(String(api.listCalls[0]?.q)).toContain(`after:${expectedAfter}`)
    expect(api.getCalls).toContain('old')
    const [state] = await db.select().from(mailboxSyncState)
    expect(state?.needsFullResync).toBe(false)
    expect(state?.historyId).toBe('200')
    expect(await db.select().from(messages)).toHaveLength(1)
  })

  it('persists failure timestamps/backoff, skips during backoff, then recovers on success', async () => {
    const account = await createAccount()
    await db.insert(mailboxSyncState).values({ accountId: account.id })
    const api = new FakeGmailApi()
    api.listError = serverError()
    const now = new Date('2026-10-21T00:00:00Z')

    await expect(
      syncAccount({
        db,
        accountId: account.id,
        api: api as unknown as GmailSyncApi,
        now,
      }),
    ).rejects.toThrow('server error')

    const [failed] = await db.select().from(mailboxSyncState)
    expect(failed?.consecutiveFailures).toBe(1)
    expect(failed?.lastFailureAt).toBeInstanceOf(Date)
    expect(failed?.lastError).toContain('server error')
    expect(failed?.backoffUntil?.getTime()).toBeGreaterThan(now.getTime())
    expect(failed?.lastPolledAt).toBeInstanceOf(Date)

    const callsBeforeSkip = api.listCalls.length
    const skipped = await syncAccount({
      db,
      accountId: account.id,
      api: api as unknown as GmailSyncApi,
      now: new Date(now.getTime() + 30_000),
    })
    expect(skipped.skipped).toBe(true)
    expect(skipped.reason).toBe('backoff')
    expect(api.listCalls).toHaveLength(callsBeforeSkip)

    await db.update(mailboxSyncState).set({ backoffUntil: null })
    api.listError = undefined
    api.messagePages = [{ messages: [{ id: 'ok' }] }]
    api.messages.set('ok', gmailMessage('ok'))
    const success = await syncAccount({
      db,
      accountId: account.id,
      api: api as unknown as GmailSyncApi,
      now: new Date(now.getTime() + 61_000),
    })
    expect(success.skipped).toBe(false)
    const [recovered] = await db.select().from(mailboxSyncState)
    expect(recovered?.consecutiveFailures).toBe(0)
    expect(recovered?.lastError).toBeNull()
    expect(recovered?.backoffUntil).toBeNull()
    expect(recovered?.lastSuccessAt).toBeInstanceOf(Date)
  })

  it('skips paused accounts without calling Gmail', async () => {
    const account = await createAccount({ status: 'paused' })
    const api = new FakeGmailApi()
    const result = await syncAccount({
      db,
      accountId: account.id,
      api: api as unknown as GmailSyncApi,
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('inactive')
    expect(api.callOrder).toEqual([])
  })
})

describe('sync helpers', () => {
  it('compares history ids without number precision loss and recognizes 404s', () => {
    expect(maxHistoryId('100', '99')).toBe('100')
    expect(maxHistoryId('99999999999999999999', '100000000000000000000')).toBe(
      '100000000000000000000',
    )
    expect(isHistoryExpiredError({ response: { status: 404 } })).toBe(true)
    expect(isHistoryExpiredError({ response: { status: 500 } })).toBe(false)
    expect(GMAIL_QUERY).toContain('-in:sent')
  })
})
