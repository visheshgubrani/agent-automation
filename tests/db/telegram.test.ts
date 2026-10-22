import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { telegramMessages, telegramUpdates } from '../../src/db/schema/index.js'
import { createTelegramChat } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('telegram ingestion', () => {
  it('dedupes chats by Telegram chat id', async () => {
    await createTelegramChat({ telegramChatId: 555 })
    await expect(createTelegramChat({ telegramChatId: 555 })).rejects.toThrow()
  })

  it('dedupes the same message within a chat', async () => {
    const chat = await createTelegramChat()
    const message = {
      chatId: chat.id,
      direction: 'inbound' as const,
      telegramMessageId: 10,
      text: 'hello',
    }
    await db.insert(telegramMessages).values(message)
    await expect(db.insert(telegramMessages).values(message)).rejects.toThrow()
  })

  it('returns conversation history in time order', async () => {
    const chat = await createTelegramChat()
    await db.insert(telegramMessages).values([
      {
        chatId: chat.id,
        direction: 'outbound',
        telegramMessageId: 2,
        text: 'newer',
        createdAt: new Date('2026-01-15T10:05:00Z'),
      },
      {
        chatId: chat.id,
        direction: 'inbound',
        telegramMessageId: 1,
        text: 'older',
        createdAt: new Date('2026-01-15T10:00:00Z'),
      },
    ])

    const rows = await db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.chatId, chat.id))
      .orderBy(telegramMessages.createdAt)

    expect(rows.map((row) => row.text)).toEqual(['older', 'newer'])
  })

  it('claims each Telegram update at most once', async () => {
    const update = {
      updateId: 900,
      kind: 'message' as const,
      payload: { update_id: 900 },
    }

    const [first] = await db
      .insert(telegramUpdates)
      .values(update)
      .onConflictDoNothing()
      .returning()
    expect(first).toBeDefined()

    const second = await db.insert(telegramUpdates).values(update).onConflictDoNothing().returning()
    expect(second).toHaveLength(0)

    const [third] = await db
      .insert(telegramUpdates)
      .values({ ...update, updateId: 901 })
      .returning()
    expect(third?.updateId).toBe(901)
  })
})
