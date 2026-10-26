import { eq, sql } from 'drizzle-orm'
import type { Update } from 'grammy/types'
import { withRun } from '../audit/runs.js'
import { type Db, db as defaultDb } from '../db/index.js'
import {
  telegramChats,
  telegramMessages,
  type telegramUpdateKind,
  telegramUpdates,
} from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import { type Logger, logger } from '../logger.js'
import { handleBrowserCallback, handleCommentCommand, handleFreeTextRequest } from './browser.js'
import { handleBrowserOperationsCommand } from './browser-operations.js'
import type { InlineButtonRows } from './buttons.js'
import { handleMailCallback, handleMailCommand, type TelegramResponder } from './mail.js'

export type TelegramUpdateKindValue = (typeof telegramUpdateKind.enumValues)[number]

export const START_REPLY = 'Bot is live. Send /ping to check delivery.'
export const PING_REPLY = 'pong'

const UPDATE_ERROR_LIMIT = 1000

interface UpdateMeta {
  updateId: number
  kind: TelegramUpdateKindValue
  chatId?: number
  messageId?: number
  messageText?: string
  chatTitle?: string | null
  callbackData?: string
}

/**
 * Extract the fields the handler needs from a raw update. Only ids/kind/text travel here;
 * the full update is stored once in `telegram_updates.payload` and never logged.
 */
function updateMeta(update: Update): UpdateMeta {
  const message = update.message ?? update.edited_message
  if (update.message !== undefined || update.edited_message !== undefined) {
    const kind = update.message !== undefined ? 'message' : 'edited_message'
    return {
      updateId: update.update_id,
      kind,
      chatId: message?.chat.id,
      messageId: message?.message_id,
      messageText: message?.text,
      chatTitle: message?.chat.title ?? message?.chat.username ?? message?.chat.first_name ?? null,
    }
  }

  if (update.callback_query !== undefined) {
    return {
      updateId: update.update_id,
      kind: 'callback_query',
      chatId: update.callback_query.message?.chat.id,
      messageId: update.callback_query.message?.message_id,
      chatTitle: update.callback_query.message?.chat.title ?? null,
      callbackData: update.callback_query.data,
    }
  }

  return { updateId: update.update_id, kind: 'other' }
}

/** The slash command of a message, with any `@botname` suffix removed. */
function commandOf(meta: UpdateMeta): string | undefined {
  const text = meta.messageText ?? ''
  if (!text.startsWith('/')) {
    return undefined
  }
  return text.slice(1).trim().split(/\s+/)[0]?.split('@')[0]
}

export interface HandleTelegramUpdateOptions {
  /** The single allowed chat id (worker config); all other chats are dropped. */
  chatId: number
  /** Send a reply into the allowed chat; returns the Telegram message id. */
  reply(text: string, options?: { buttons?: InlineButtonRows }): Promise<number>
  /** Edit a bot message in place; required for paginated review and rule previews. */
  editMessage?(
    messageId: number,
    text: string,
    options?: { buttons?: InlineButtonRows },
  ): Promise<void>
  /** Acknowledge a callback query; text is a short toast (max 200 characters). */
  answerCallback?(text?: string): Promise<void>
  /**
   * Enqueue a background job (the agent-intake and browser-task queues). Absent when the
   * browser agent is disabled; `/comment` then answers that it is unavailable.
   */
  enqueue?(queue: string, data: Record<string, unknown>): Promise<void>
  /** Immediate notification dispatch nudge after a callback commits a card. */
  nudgeDispatch?(): Promise<void>
  /** HTTPS browser view URL used by result-card buttons. */
  browserViewUrl?: string
  db?: Db
  log?: Logger
}

/**
 * Handle one long-polled Telegram update:
 *
 * 1. chat-ID lock first — unauthorized (or chatless) updates are logged and dropped with no
 *    DB rows and no reply;
 * 2. claim `telegram_updates.update_id` with ON CONFLICT DO NOTHING — duplicates no-op;
 * 3. `withRun(agent_chat, telegram)` → upsert chat → store the inbound message (run id set,
 *    conflict-safe on `(chat_id, telegram_message_id)`) → reply to `/start` and `/ping` and
 *    store the outbound message → mark processed;
 * 4. on failure: store a bounded `telegram_updates.error`, the run fails, log, and do not
 *    retry (the poller moves on; duplicates are handled by the claim).
 */
export async function handleTelegramUpdate(
  update: Update,
  options: HandleTelegramUpdateOptions,
): Promise<void> {
  const db = options.db ?? defaultDb
  const log = options.log ?? logger
  const meta = updateMeta(update)

  if (meta.chatId === undefined || meta.chatId !== options.chatId) {
    log.warn(
      { updateId: meta.updateId, kind: meta.kind, chatId: meta.chatId ?? null },
      'telegram update from unauthorized chat ignored',
    )
    return
  }
  const chatId = meta.chatId

  const claimed = await claimUpdate(db, meta, update)
  if (!claimed) {
    log.debug({ updateId: meta.updateId }, 'duplicate telegram update ignored')
    return
  }

  let responder: TelegramResponder | undefined

  try {
    await withRun(
      {
        db,
        log,
        kind: 'agent_chat',
        trigger: 'telegram',
        input: { updateId: meta.updateId, kind: meta.kind },
      },
      async ({ run }) => {
        const chat = await upsertChat(db, chatId, meta.chatTitle)
        let answered = false

        const mailResponder: TelegramResponder = {
          reply: async (text, replyOptions) => {
            const telegramMessageId = await options.reply(
              text,
              replyOptions?.buttons ? { buttons: replyOptions.buttons } : undefined,
            )
            await storeOutboundMessage(
              db,
              chat.id,
              run.id,
              telegramMessageId,
              text,
              replyOptions?.payload,
            )
            return telegramMessageId
          },
          editMessage: async (messageId, text, replyOptions) => {
            if (!options.editMessage) {
              throw new Error('telegram editMessage is not available')
            }
            await options.editMessage(
              messageId,
              text,
              replyOptions?.buttons ? { buttons: replyOptions.buttons } : undefined,
            )
            await storeOutboundMessage(db, chat.id, run.id, messageId, text, replyOptions?.payload)
          },
          answerCallback: async (text) => {
            if (answered) return
            answered = true
            await options.answerCallback?.(text)
          },
          hasAnsweredCallback: () => answered,
        }
        responder = mailResponder

        // Store the inbound message; a replayed update finds its row already there. The row id
        // is the intake idempotency anchor (`browser_tasks.request_message_id`).
        let inboundMessageId: string | undefined
        if (meta.kind === 'message' && meta.messageId !== undefined) {
          const [inbound] = await db
            .insert(telegramMessages)
            .values({
              chatId: chat.id,
              direction: 'inbound',
              telegramMessageId: meta.messageId,
              text: meta.messageText ?? '',
              replyToTelegramMessageId: update.message?.reply_to_message?.message_id ?? null,
              payload: update as unknown as Record<string, unknown>,
              runId: run.id,
            })
            .onConflictDoNothing({
              target: [telegramMessages.chatId, telegramMessages.telegramMessageId],
            })
            .returning({ id: telegramMessages.id })
          inboundMessageId = inbound?.id
        }

        const browserContext = {
          db,
          chatDbId: chat.id,
          runId: run.id,
          updateId: meta.updateId,
          responder: mailResponder,
          log,
          ...(options.enqueue !== undefined ? { enqueue: options.enqueue } : {}),
          ...(options.nudgeDispatch !== undefined ? { nudge: options.nudgeDispatch } : {}),
          ...(options.browserViewUrl !== undefined ? { viewUrl: options.browserViewUrl } : {}),
        }

        if (meta.kind === 'callback_query') {
          const data = meta.callbackData ?? ''
          if (data.startsWith('bt:') || data.startsWith('bs:')) {
            await handleBrowserCallback(data, meta.messageId, browserContext)
          } else {
            await handleMailCallback(data, meta.messageId, {
              db,
              chatDbId: chat.id,
              runId: run.id,
              responder: mailResponder,
              log,
            })
          }
        } else {
          // Commands remain deterministic; ordinary text is parsed in the background intake job.
          const command = commandOf(meta)
          if (command === 'comment') {
            if (inboundMessageId === undefined) {
              await mailResponder.reply('Could not record this message; please send it again.')
            } else {
              await handleCommentCommand(meta.messageText ?? '', {
                ...browserContext,
                inboundMessageId,
              })
            }
          } else if (command === 'tasks' || command === 'stop' || command === 'schedules') {
            await handleBrowserOperationsCommand(command, browserContext)
          } else if (command === 'mail') {
            await handleMailCommand(meta.messageText ?? '', {
              db,
              chatDbId: chat.id,
              runId: run.id,
              responder: mailResponder,
              log,
            })
          } else {
            const replyText =
              command === 'ping' ? PING_REPLY : command === 'start' ? START_REPLY : undefined
            if (replyText !== undefined) {
              await mailResponder.reply(replyText)
            } else if (
              meta.kind === 'message' &&
              !command &&
              meta.messageText?.trim() &&
              inboundMessageId
            ) {
              await handleFreeTextRequest({ ...browserContext, inboundMessageId })
            }
          }
        }

        await db
          .update(telegramUpdates)
          .set({ processedAt: new Date() })
          .where(eq(telegramUpdates.updateId, meta.updateId))
      },
    )
  } catch (error) {
    await recordUpdateError(db, meta.updateId, error)
    log.error(
      { updateId: meta.updateId, err: errorMessage(error) },
      'telegram update failed; recorded, not retried',
    )
  } finally {
    // A callback must always be acknowledged, even when its handler fails before answering.
    if (
      meta.kind === 'callback_query' &&
      !responder?.hasAnsweredCallback() &&
      options.answerCallback
    ) {
      await options.answerCallback().catch((error) => {
        log.warn(
          { updateId: meta.updateId, err: errorMessage(error) },
          'telegram callback acknowledgement failed',
        )
      })
    }
  }
}

/** Claim the update id; returns the row, or undefined when it was already claimed. */
async function claimUpdate(
  db: Db,
  meta: UpdateMeta,
  update: Update,
): Promise<typeof telegramUpdates.$inferSelect | undefined> {
  const [row] = await db
    .insert(telegramUpdates)
    .values({
      updateId: meta.updateId,
      kind: meta.kind,
      telegramChatId: meta.chatId ?? null,
      telegramMessageId: meta.messageId ?? null,
      payload: update as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: telegramUpdates.updateId })
    .returning()
  return row
}

async function upsertChat(
  db: Db,
  telegramChatId: number,
  title?: string | null,
): Promise<typeof telegramChats.$inferSelect> {
  const [row] = await db
    .insert(telegramChats)
    .values({ telegramChatId, title: title ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: telegramChats.telegramChatId,
      set: {
        title: sql`coalesce(excluded.title, ${telegramChats.title})`,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!row) {
    throw new Error(`upsertChat did not return a row for chat ${telegramChatId}`)
  }
  return row
}

async function recordUpdateError(db: Db, updateId: number, error: unknown): Promise<void> {
  await db
    .update(telegramUpdates)
    .set({ error: errorMessage(error, UPDATE_ERROR_LIMIT) })
    .where(eq(telegramUpdates.updateId, updateId))
}

/**
 * Store or refresh an outbound bot message. The payload is app metadata (review page, rule draft)
 * used to validate later callbacks; it is never sent to Telegram.
 */
async function storeOutboundMessage(
  db: Db,
  chatId: string,
  runId: string,
  telegramMessageId: number,
  text: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(telegramMessages)
    .values({
      chatId,
      direction: 'outbound',
      telegramMessageId,
      text,
      payload: payload ?? {},
      runId,
    })
    .onConflictDoUpdate({
      target: [telegramMessages.chatId, telegramMessages.telegramMessageId],
      set: {
        text,
        runId,
        ...(payload !== undefined ? { payload } : {}),
      },
    })
}
