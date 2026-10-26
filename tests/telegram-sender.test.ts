import { GrammyError, InputFile } from 'grammy'
import { describe, expect, it, vi } from 'vitest'
import { classifyTelegramSendError } from '../src/errors.js'
import type { InlineButtonRows } from '../src/telegram/buttons.js'
import {
  createTelegramSender,
  TELEGRAM_BODY_LIMIT,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_SEND_TIMEOUT_MS,
  type TelegramApi,
  TelegramBodyTooLongError,
  TelegramCaptionTooLongError,
  TelegramInvalidButtonsError,
} from '../src/telegram/sender.js'

const CHAT_ID = 42

function fakeApi(
  impl: (text: string, signal: AbortSignal | undefined) => Promise<{ message_id: number }>,
): {
  api: TelegramApi
  calls: string[]
  other: ({ reply_markup?: unknown } | undefined)[]
  signals: (AbortSignal | undefined)[]
} {
  const calls: string[] = []
  const other: ({ reply_markup?: unknown } | undefined)[] = []
  const signals: (AbortSignal | undefined)[] = []
  return {
    calls,
    other,
    signals,
    api: {
      sendMessage: async (chatId, text, sendOptions, signal) => {
        calls.push(text)
        other.push(sendOptions)
        signals.push(signal)
        expect(chatId).toBe(CHAT_ID)
        return impl(text, signal)
      },
      sendPhoto: async () => ({ message_id: 0 }),
    },
  }
}

function photoApi() {
  const calls: {
    photo: InputFile
    caption: string | undefined
    other: { caption?: string; reply_markup?: unknown } | undefined
  }[] = []
  const api: TelegramApi = {
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async (chatId, photo, other, signal) => {
      expect(chatId).toBe(CHAT_ID)
      expect(signal).toBeInstanceOf(AbortSignal)
      calls.push({ photo, caption: other?.caption, other })
      return { message_id: 55 }
    },
  }
  return { api, calls }
}

describe('createTelegramSender', () => {
  it('sends plain text to the configured chat and returns the message id', async () => {
    const { api, calls, signals } = fakeApi(async () => ({ message_id: 7 }))
    const sender = createTelegramSender({ chatId: CHAT_ID, botToken: 'x', api })
    const result = await sender.send('hello')

    expect(result).toEqual({ messageId: 7 })
    expect(calls).toEqual(['hello'])
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('sends validated inline buttons as Telegram reply markup', async () => {
    const { api, other } = fakeApi(async () => ({ message_id: 8 }))
    const sender = createTelegramSender({ chatId: CHAT_ID, botToken: 'x', api })
    const buttons: InlineButtonRows = [
      [
        { text: 'Useful', callbackData: 'mail:useful:123' },
        { text: 'Not important', callbackData: 'mail:not_important:123' },
      ],
      [{ text: 'Create rule', callbackData: 'mail:create_rule:123' }],
    ]

    await sender.send('alert', { buttons })

    expect(other[0]).toEqual({
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Useful', callback_data: 'mail:useful:123' },
            { text: 'Not important', callback_data: 'mail:not_important:123' },
          ],
          [{ text: 'Create rule', callback_data: 'mail:create_rule:123' }],
        ],
      },
    })
  })

  it('rejects invalid programmatic buttons before calling Telegram', async () => {
    const { api, calls } = fakeApi(async () => ({ message_id: 1 }))
    const sender = createTelegramSender({ chatId: CHAT_ID, botToken: 'x', api })

    await expect(
      sender.send('alert', {
        buttons: [[{ text: '', callbackData: 'x' }]],
      }),
    ).rejects.toBeInstanceOf(TelegramInvalidButtonsError)
    expect(calls).toHaveLength(0)
  })

  it('guards the 4096-character limit before calling Telegram', async () => {
    const { api, calls } = fakeApi(async () => ({ message_id: 1 }))
    const sender = createTelegramSender({ chatId: CHAT_ID, botToken: 'x', api })

    await expect(sender.send('x'.repeat(TELEGRAM_BODY_LIMIT))).resolves.toBeTruthy()
    await expect(sender.send('x'.repeat(TELEGRAM_BODY_LIMIT + 1))).rejects.toBeInstanceOf(
      TelegramBodyTooLongError,
    )
    expect(calls).toHaveLength(1)
  })

  it('aborts a send that exceeds the deadline and surfaces an uncertain timeout', async () => {
    vi.useFakeTimers()
    try {
      const { api } = fakeApi(
        (_text, signal) =>
          new Promise<{ message_id: number }>((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason))
          }),
      )
      const sender = createTelegramSender({ chatId: CHAT_ID, botToken: 'x', api, timeoutMs: 25 })

      let caught: unknown
      const pending = sender.send('slow').catch((error) => {
        caught = error
        return 'caught'
      })
      await vi.advanceTimersByTimeAsync(30)
      await pending

      expect(String(caught)).toContain('timed out')
      const failure = classifyTelegramSendError(caught)
      expect(failure.kind).toBe('uncertain')
      expect(failure.reason).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the documented 15s default deadline', () => {
    expect(TELEGRAM_SEND_TIMEOUT_MS).toBe(15_000)
  })

  it('propagates API errors that the dispatcher classifies (429 retry-after)', async () => {
    const { api } = fakeApi(async () => {
      throw new GrammyError(
        `Call to 'sendMessage' failed!`,
        {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 7 },
        },
        'sendMessage',
        {},
      )
    })
    const sender = createTelegramSender({ chatId: CHAT_ID, botToken: 'x', api })

    await expect(sender.send('x')).rejects.toMatchObject({ error_code: 429 })
  })

  it('sends a screenshot as a PNG with its caption and URL buttons', async () => {
    const { api, calls } = photoApi()
    const sender = createTelegramSender({ chatId: CHAT_ID, botToken: 'x', api })
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01])

    const result = await sender.sendPhoto(bytes, 'Task #abcd — Reddit comment', {
      buttons: [[{ text: 'Open browser', url: 'https://box.tail1234.ts.net/' }]],
    })

    expect(result).toEqual({ messageId: 55 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.photo).toBeInstanceOf(InputFile)
    expect(calls[0]?.photo.filename).toBe('screenshot.png')
    expect(new Uint8Array((await calls[0]?.photo.toRaw()) as Uint8Array)).toEqual(bytes)
    expect(calls[0]?.caption).toBe('Task #abcd — Reddit comment')
    expect(calls[0]?.other?.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Open browser', url: 'https://box.tail1234.ts.net/' }]],
    })
  })

  it('guards the caption limit and empty photos before calling Telegram', async () => {
    const { api, calls } = photoApi()
    const sender = createTelegramSender({ chatId: CHAT_ID, botToken: 'x', api })

    await expect(
      sender.sendPhoto(new Uint8Array([1]), 'x'.repeat(TELEGRAM_CAPTION_LIMIT + 1)),
    ).rejects.toBeInstanceOf(TelegramCaptionTooLongError)
    await expect(sender.sendPhoto(new Uint8Array(), 'caption')).rejects.toThrow('empty photo')
    expect(calls).toHaveLength(0)
  })

  it('requires a bot token or an injected api', () => {
    expect(() => createTelegramSender({ chatId: CHAT_ID })).toThrow('bot token')
  })
})
