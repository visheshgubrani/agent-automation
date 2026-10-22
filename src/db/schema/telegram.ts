import { sql } from 'drizzle-orm'
import { bigint, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { telegramDirection, telegramUpdateKind } from './enums.js'
import { runs } from './runs.js'
import { timestamps } from './types.js'

/** One allowed private chat in V1. */
export const telegramChats = pgTable(
  'telegram_chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }).notNull(),
    title: text('title'),
    ...timestamps(),
  },
  (t) => [unique('telegram_chats_telegram_chat_id_uq').on(t.telegramChatId)],
)

/** Conversation history for the on-demand agent (both directions). */
export const telegramMessages = pgTable(
  'telegram_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => telegramChats.id, { onDelete: 'cascade' }),
    direction: telegramDirection('direction').notNull(),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }).notNull(),
    replyToTelegramMessageId: bigint('reply_to_telegram_message_id', { mode: 'number' }),
    text: text('text').notNull().default(''),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('telegram_messages_chat_message_uq').on(t.chatId, t.telegramMessageId),
    index('telegram_messages_history_idx').on(t.chatId, t.createdAt),
    index('telegram_messages_run_idx').on(t.runId).where(sql`${t.runId} is not null`),
  ],
)

/** Claimed Telegram updates; the primary key is the webhook/poll idempotency guard. */
export const telegramUpdates = pgTable(
  'telegram_updates',
  {
    updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
    kind: telegramUpdateKind('kind').notNull(),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [index('telegram_updates_received_idx').on(t.receivedAt)],
)
