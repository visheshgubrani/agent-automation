import { Api } from 'grammy'
import {
  type InlineButtonRows,
  type TelegramReplyMarkup,
  toTelegramReplyMarkup,
  validateInlineButtons,
} from './buttons.js'

/** Telegram message length cap for plain-text sendMessage calls. */
export const TELEGRAM_BODY_LIMIT = 4096

/** Default per-send deadline. Shutdown does not abort the in-flight send; this bounds it. */
export const TELEGRAM_SEND_TIMEOUT_MS = 15_000

/** Thrown by the sender before any API call when the body exceeds the Telegram limit. */
export class TelegramBodyTooLongError extends Error {
  /** Body length in characters; the body itself is never included. */
  readonly length: number

  constructor(length: number) {
    super(`telegram body too long: ${length} > ${TELEGRAM_BODY_LIMIT} characters`)
    this.name = 'TelegramBodyTooLongError'
    this.length = length
  }
}

/** Thrown before any API call when programmatic inline buttons fail validation. */
export class TelegramInvalidButtonsError extends Error {
  constructor() {
    super('telegram inline buttons are invalid')
    this.name = 'TelegramInvalidButtonsError'
  }
}

/** Timeout marker used as the abort reason; classification reads its name. */
class SendTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`telegram send timed out after ${timeoutMs}ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * The slice of the Telegram send path the sender depends on (injectable for tests). Defined
 * as our own shape — the real `Api` method accepts a standard AbortSignal at runtime; the
 * cast below only bridges grammy's bundled abort-controller typing.
 */
export type TelegramApi = {
  sendMessage(
    chatId: number,
    text: string,
    other?: { reply_markup?: TelegramReplyMarkup },
    signal?: AbortSignal,
  ): Promise<{ message_id: number }>
}

export interface TelegramSendOptions {
  /** Pre-validated inline buttons. Invalid programmatic input is rejected before sending. */
  buttons?: InlineButtonRows
}

export interface TelegramSendResult {
  /** Telegram message id of the delivered message. */
  messageId: number
}

/** Sends plain-text messages to the single configured chat. */
export interface TelegramSender {
  readonly chatId: number
  /**
   * Send one plain-text message, optionally with inline buttons. Throws
   * `TelegramBodyTooLongError` without calling Telegram when the text exceeds 4096 characters;
   * all other errors are network/API failures for `classifyTelegramSendError` to categorize.
   */
  send(text: string, options?: TelegramSendOptions): Promise<TelegramSendResult>
}

export interface CreateTelegramSenderOptions {
  /** The single allowed recipient chat; taken from worker config, never from rows. */
  chatId: number
  botToken?: string
  timeoutMs?: number
  /** Test seam; defaults to `new Api(botToken)`. */
  api?: TelegramApi
}

/**
 * Telegram delivery adapter for the outbox dispatcher: fixed recipient, no parse mode,
 * 15s abortable timeout, 4096-character guard, and validated inline buttons.
 */
export function createTelegramSender(options: CreateTelegramSenderOptions): TelegramSender {
  const { chatId } = options
  if (options.api === undefined && !options.botToken) {
    throw new Error('createTelegramSender requires a bot token or an injected Api')
  }
  const api: TelegramApi =
    options.api ?? (new Api(options.botToken ?? '') as unknown as TelegramApi)
  const timeoutMs = options.timeoutMs ?? TELEGRAM_SEND_TIMEOUT_MS

  return {
    chatId,
    async send(text: string, sendOptions?: TelegramSendOptions): Promise<TelegramSendResult> {
      if (text.length > TELEGRAM_BODY_LIMIT) {
        throw new TelegramBodyTooLongError(text.length)
      }

      const buttons =
        sendOptions?.buttons === undefined ? undefined : validateInlineButtons(sendOptions.buttons)
      if (sendOptions?.buttons !== undefined && buttons === undefined) {
        throw new TelegramInvalidButtonsError()
      }

      // Aborting with a TimeoutError reason makes the fetch reject with it, so grammy wraps
      // it in an HttpError whose cause chain classifies as an uncertain timeout.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new SendTimeoutError(timeoutMs)), timeoutMs)
      try {
        const other =
          buttons === undefined ? undefined : { reply_markup: toTelegramReplyMarkup(buttons) }
        const message = await api.sendMessage(chatId, text, other, controller.signal)
        return { messageId: message.message_id }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
