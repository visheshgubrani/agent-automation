import { Bot, GrammyError } from 'grammy'
import type { Update } from 'grammy/types'
import { type Db, db as defaultDb } from '../db/index.js'
import { errorMessage } from '../errors.js'
import { type Logger, logger } from '../logger.js'
import { toTelegramReplyMarkup } from './buttons.js'
import { handleTelegramUpdate } from './updates.js'

export interface CreateTelegramBotOptions {
  botToken: string
  /** The single allowed chat (worker config). */
  chatId: number
  db?: Db
  log?: Logger
}

export interface TelegramBotHandle {
  readonly bot: Bot
  /**
   * Begin long polling. Resolves only when polling stops (grammy semantics); rejects when
   * startup fails (e.g. invalid token) — the worker treats that as fatal.
   */
  start(): Promise<void>
  /** Stop long polling. Safe to call before/without start; in-flight handlers keep running. */
  stop(): Promise<void>
  /** Currently executing update handlers; the drain waits for this to reach zero. */
  inFlightHandlers(): number
}

/**
 * grammy long-polling bot for the single allowed chat (D023).
 *
 * Every update flows through one in-flight-counted middleware that delegates to
 * `handleTelegramUpdate`; `bot.catch` logs poller/middleware failures without payloads.
 * `drop_pending_updates: false` replays missed updates after downtime — harmless for the
 * idempotent `/ping`; revisit deliberately when approvals/agent commands can replay.
 */
export function createTelegramBot(options: CreateTelegramBotOptions): TelegramBotHandle {
  const db = options.db ?? defaultDb
  const log = options.log ?? logger
  const bot = new Bot(options.botToken)

  let inFlightHandlers = 0

  bot.use(async (ctx, next) => {
    inFlightHandlers += 1
    try {
      await handleTelegramUpdate(ctx.update as Update, {
        chatId: options.chatId,
        db,
        log,
        reply: async (text, replyOptions) => {
          const message = await ctx.reply(
            text,
            replyOptions?.buttons
              ? { reply_markup: toTelegramReplyMarkup(replyOptions.buttons) }
              : undefined,
          )
          return message.message_id
        },
        editMessage: async (messageId, text, replyOptions) => {
          try {
            await ctx.api.editMessageText(
              options.chatId,
              messageId,
              text,
              replyOptions?.buttons
                ? { reply_markup: toTelegramReplyMarkup(replyOptions.buttons) }
                : undefined,
            )
          } catch (error) {
            // Editing an unchanged review/rule page is an idempotent no-op, not a failure.
            if (
              error instanceof GrammyError &&
              error.description.toLowerCase().includes('message is not modified')
            ) {
              return
            }
            throw error
          }
        },
        answerCallback: async (text) => {
          if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery(text ? { text } : undefined)
          }
        },
      })
      await next()
    } finally {
      inFlightHandlers -= 1
    }
  })

  bot.catch((error) => {
    log.error({ err: errorMessage(error.error) }, 'telegram bot error')
  })

  let polling: Promise<void> | undefined

  return {
    bot,
    inFlightHandlers: () => inFlightHandlers,
    start() {
      if (polling) {
        return polling
      }
      polling = bot.start({
        drop_pending_updates: false,
        onStart: (me) =>
          log.info({ botId: me.id, botUsername: me.username }, 'telegram bot polling started'),
      })
      return polling
    },
    stop() {
      return polling ? bot.stop() : Promise.resolve()
    },
  }
}
