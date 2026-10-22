import { eq } from 'drizzle-orm'
import type { Update } from 'grammy/types'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runs, telegramMessages, telegramUpdates } from '../src/db/schema/index.js'
import { createTelegramBot } from '../src/telegram/bot.js'
import { handleTelegramUpdate, PING_REPLY, START_REPLY } from '../src/telegram/updates.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

const CHAT_ID = 42
const UNAUTHORIZED_CHAT_ID = 999
const BOT_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

let updateIdSeq = 0
function messageUpdate(chatId: number, text: string, messageId = 500): Update {
  updateIdSeq += 1
  return {
    update_id: updateIdSeq,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Tester', username: 'tester' },
      from: { id: chatId, is_bot: false, first_name: 'Tester', username: 'tester' },
      text,
    },
  } as unknown as Update
}

function editedMessageUpdate(chatId: number): Update {
  updateIdSeq += 1
  return {
    update_id: updateIdSeq,
    edited_message: {
      message_id: 501,
      date: Math.floor(Date.now() / 1000),
      edit_date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Tester' },
      text: 'edited text',
    },
  } as unknown as Update
}

function fakeReply(behavior: (text: string) => void = () => undefined) {
  const replies: string[] = []
  return {
    replies,
    reply: async (text: string) => {
      behavior(text)
      replies.push(text)
      return 1_000 + replies.length
    },
  }
}

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('handleTelegramUpdate', () => {
  it('ignores unauthorized chats with no rows and no reply', async () => {
    const { reply, replies } = fakeReply()

    await handleTelegramUpdate(messageUpdate(UNAUTHORIZED_CHAT_ID, '/ping'), {
      chatId: CHAT_ID,
      reply,
    })

    expect(replies).toEqual([])
    expect(await db.select().from(telegramUpdates)).toHaveLength(0)
    expect(await db.select().from(runs)).toHaveLength(0)
  })

  it('replies to /ping once and stores update, chat, messages, and run', async () => {
    const { reply, replies } = fakeReply()

    await handleTelegramUpdate(messageUpdate(CHAT_ID, '/ping'), { chatId: CHAT_ID, reply })
    expect(replies).toEqual([PING_REPLY])

    const [update] = await db.select().from(telegramUpdates)
    expect(update?.processedAt).toBeInstanceOf(Date)
    expect(update?.error).toBeNull()
    expect(update?.kind).toBe('message')

    const messages = await db.select().from(telegramMessages)
    expect(messages).toHaveLength(2)
    const inbound = messages.find((m) => m.direction === 'inbound')
    const outbound = messages.find((m) => m.direction === 'outbound')
    expect(inbound).toMatchObject({ telegramMessageId: 500, text: '/ping' })
    expect(inbound?.runId).toBeTypeOf('string')
    expect(outbound).toMatchObject({ telegramMessageId: 1_001, text: PING_REPLY })
    expect(outbound?.runId).toBe(inbound?.runId)
    const runId = inbound?.runId
    if (!runId) throw new Error('expected the inbound message to carry a run id')

    const [run] = await db.select().from(runs).where(eq(runs.id, runId))
    expect(run).toMatchObject({ kind: 'agent_chat', trigger: 'telegram', status: 'succeeded' })
    expect(run?.finishedAt).toBeInstanceOf(Date)
  })

  it('replies to /start with a welcome and audits non-command messages without a reply', async () => {
    const start = fakeReply()
    await handleTelegramUpdate(messageUpdate(CHAT_ID, '/start'), {
      chatId: CHAT_ID,
      reply: start.reply,
    })
    expect(start.replies).toEqual([START_REPLY])

    const plain = fakeReply()
    await handleTelegramUpdate(messageUpdate(CHAT_ID, 'just a hello', 502), {
      chatId: CHAT_ID,
      reply: plain.reply,
    })
    expect(plain.replies).toEqual([])
    const [update] = await db
      .select()
      .from(telegramUpdates)
      .where(eq(telegramUpdates.updateId, updateIdSeq))
    expect(update?.processedAt).toBeInstanceOf(Date)
  })

  it('ignores duplicate update ids as a no-op', async () => {
    const update = messageUpdate(CHAT_ID, '/ping', 503)

    const first = fakeReply()
    await handleTelegramUpdate(update, { chatId: CHAT_ID, reply: first.reply })

    const second = fakeReply()
    await handleTelegramUpdate(update, { chatId: CHAT_ID, reply: second.reply })
    expect(second.replies).toEqual([])

    expect(await db.select().from(telegramUpdates)).toHaveLength(1)
    expect(await db.select().from(telegramMessages)).toHaveLength(2)
    expect(await db.select().from(runs)).toHaveLength(1)
  })

  it('audits edited messages without storing an inbound message or replying', async () => {
    const { reply, replies } = fakeReply()

    await handleTelegramUpdate(editedMessageUpdate(CHAT_ID), { chatId: CHAT_ID, reply })
    expect(replies).toEqual([])

    const [update] = await db.select().from(telegramUpdates)
    expect(update?.kind).toBe('edited_message')
    expect(update?.processedAt).toBeInstanceOf(Date)
    expect(await db.select().from(telegramMessages)).toHaveLength(0)
    expect(await db.select().from(runs)).toHaveLength(1)
  })

  it('records the error on failure: update error, failed run, no outbound message', async () => {
    const { reply } = fakeReply(() => {
      throw new Error('telegram reply failed')
    })

    await handleTelegramUpdate(messageUpdate(CHAT_ID, '/ping', 504), { chatId: CHAT_ID, reply })

    const [update] = await db.select().from(telegramUpdates)
    expect(update?.error).toContain('telegram reply failed')
    expect(update?.processedAt).toBeNull()

    const messages = await db.select().from(telegramMessages)
    expect(messages).toHaveLength(1) // inbound only
    expect(messages[0]?.direction).toBe('inbound')

    const [run] = await db.select().from(runs)
    expect(run).toMatchObject({ kind: 'agent_chat', status: 'failed' })
    expect(run?.error).toContain('telegram reply failed')
    expect(run?.finishedAt).toBeInstanceOf(Date)
  })
})

describe('createTelegramBot handle', () => {
  it('exposes start/stop guards and the in-flight counter without polling', async () => {
    const bot = createTelegramBot({ botToken: BOT_TOKEN, chatId: CHAT_ID })
    expect(bot.inFlightHandlers()).toBe(0)
    await expect(bot.stop()).resolves.toBeUndefined() // no-op before start
  })
})
