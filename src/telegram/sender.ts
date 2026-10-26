import { Api, InputFile } from 'grammy'
import {
  type InlineButtonRows,
  type TelegramReplyMarkup,
  toTelegramReplyMarkup,
  validateInlineButtons,
} from './buttons.js'

/** Telegram message length cap for plain-text sendMessage calls. */
export const TELEGRAM_BODY_LIMIT = 4096

/** Telegram caption length cap when a message carries a photo. */
export const TELEGRAM_CAPTION_LIMIT = 1024

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

/** Thrown before any API call when a photo caption exceeds Telegram's caption limit. */
export class TelegramCaptionTooLongError extends Error {
  readonly length: number

  constructor(length: number) {
    super(`telegram caption too long: ${length} > ${TELEGRAM_CAPTION_LIMIT} characters`)
    this.name = 'TelegramCaptionTooLongError'
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
  sendPhoto(
    chatId: number,
    photo: InputFile,
    other?: { caption?: string; reply_markup?: TelegramReplyMarkup },
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

/** Sends plain-text messages and screenshots to the single configured chat. */
export interface TelegramSender {
  readonly chatId: number
  /**
   * Send one plain-text message, optionally with inline buttons. Throws
   * `TelegramBodyTooLongError` without calling Telegram when the text exceeds 4096 characters;
   * all other errors are network/API failures for `classifyTelegramSendError` to categorize.
   */
  send(text: string, options?: TelegramSendOptions): Promise<TelegramSendResult>
  /**
   * Send one PNG screenshot with a caption, optionally with inline buttons. The caption has its
   * own 1024-character limit, enforced before any API call.
   */
  sendPhoto(
    photo: Uint8Array,
    caption: string,
    options?: TelegramSendOptions,
  ): Promise<TelegramSendResult>
}

export interface CreateTelegramSenderOptions {
  /** The single allowed recipient chat; taken from worker config, never from rows. */
  chatId: number
  botToken?: string
  timeoutMs?: number
  /** Test seam; defaults to `new Api(botToken)`. */
  api?: TelegramApi
}

function prepareMarkup(buttons: InlineButtonRows | undefined): TelegramReplyMarkup | undefined {
  if (buttons === undefined) return undefined
  const validated = validateInlineButtons(buttons)
  if (validated === undefined) throw new TelegramInvalidButtonsError()
  return toTelegramReplyMarkup(validated)
}

/**
 * Telegram delivery adapter for the outbox dispatcher: fixed recipient, no parse mode,
 * 15s abortable timeout, 4096-character text guard (1024 for captions), and validated
 * inline buttons.
 */
export function createTelegramSender(options: CreateTelegramSenderOptions): TelegramSender {
  const { chatId } = options
  if (options.api === undefined && !options.botToken) {
    throw new Error('createTelegramSender requires a bot token or an injected Api')
  }
  const api: TelegramApi =
    options.api ?? (new Api(options.botToken ?? '') as unknown as TelegramApi)
  const timeoutMs = options.timeoutMs ?? TELEGRAM_SEND_TIMEOUT_MS

  // Aborting with a TimeoutError reason makes the fetch reject with it, so grammy wraps it in
  // an HttpError whose cause chain classifies as an uncertain timeout.
  const withDeadline = async <T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new SendTimeoutError(timeoutMs)), timeoutMs)
    try {
      return await call(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    chatId,
    async send(text: string, sendOptions?: TelegramSendOptions): Promise<TelegramSendResult> {
      if (text.length > TELEGRAM_BODY_LIMIT) {
        throw new TelegramBodyTooLongError(text.length)
      }
      const replyMarkup = prepareMarkup(sendOptions?.buttons)
      const other = replyMarkup === undefined ? undefined : { reply_markup: replyMarkup }
      const message = await withDeadline((signal) => api.sendMessage(chatId, text, other, signal))
      return { messageId: message.message_id }
    },
    async sendPhoto(
      photo: Uint8Array,
      caption: string,
      sendOptions?: TelegramSendOptions,
    ): Promise<TelegramSendResult> {
      if (photo.byteLength === 0) throw new Error('refusing to send an empty photo')
      if (caption.length > TELEGRAM_CAPTION_LIMIT) {
        throw new TelegramCaptionTooLongError(caption.length)
      }
      const replyMarkup = prepareMarkup(sendOptions?.buttons)
      const file = new InputFile(photo, 'screenshot.png')
      const other = {
        caption,
        ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
      }
      const message = await withDeadline((signal) => api.sendPhoto(chatId, file, other, signal))
      return { messageId: message.message_id }
    },
  }
}
