/** Telegram limits for inline keyboards. */
export const TELEGRAM_CALLBACK_DATA_LIMIT = 64
export const TELEGRAM_BUTTON_TEXT_LIMIT = 64
export const TELEGRAM_BUTTON_URL_LIMIT = 2_048
export const MAX_INLINE_BUTTON_ROWS = 8
export const MAX_INLINE_BUTTONS_PER_ROW = 8

export interface InlineButton {
  text: string
  /** Opaque callback payload; validated against stored records when a callback arrives. */
  callbackData?: string
  /** https link button (for example the browser view). Mutually exclusive with callbackData. */
  url?: string
}

export type InlineButtonRows = InlineButton[][]

export type TelegramReplyButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramReplyButton[][]
}

function withinCallbackLimit(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= TELEGRAM_CALLBACK_DATA_LIMIT
}

/** A link button must be a plain https URL: it is sent to Telegram, never used for API calls. */
function isSafeButtonUrl(value: string): boolean {
  if (value.length === 0 || value.length > TELEGRAM_BUTTON_URL_LIMIT) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

/** Trim and validate one Telegram inline button; returns undefined when unusable. */
function parseButton(value: unknown): InlineButton | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { text?: unknown; callbackData?: unknown; url?: unknown }
  if (typeof candidate.text !== 'string') return undefined

  const text = candidate.text.trim()
  if (text.length === 0 || text.length > TELEGRAM_BUTTON_TEXT_LIMIT) return undefined

  const hasCallback = candidate.callbackData !== undefined
  const hasUrl = candidate.url !== undefined
  if (hasCallback === hasUrl) return undefined

  if (hasCallback) {
    if (typeof candidate.callbackData !== 'string') return undefined
    const callbackData = candidate.callbackData.trim()
    if (callbackData.length === 0 || !withinCallbackLimit(callbackData)) return undefined
    return { text, callbackData }
  }

  if (typeof candidate.url !== 'string' || !isSafeButtonUrl(candidate.url.trim())) {
    return undefined
  }
  return { text, url: candidate.url.trim() }
}

/**
 * Validate an inline-keyboard shape from the outbox payload or a caller.
 *
 * Returns `undefined` for an absent, empty, oversized, or malformed keyboard. Invalid data is
 * omitted rather than sent to Telegram; the alert text itself is still delivered.
 */
export function validateInlineButtons(value: unknown): InlineButtonRows | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INLINE_BUTTON_ROWS) {
    return undefined
  }

  const rows: InlineButtonRows = []
  for (const rawRow of value) {
    if (
      !Array.isArray(rawRow) ||
      rawRow.length === 0 ||
      rawRow.length > MAX_INLINE_BUTTONS_PER_ROW
    ) {
      return undefined
    }
    const row: InlineButton[] = []
    for (const rawButton of rawRow) {
      const button = parseButton(rawButton)
      if (!button) return undefined
      row.push(button)
    }
    rows.push(row)
  }
  return rows
}

/** Read and validate the `inlineButtons` array from an outbox payload. */
export function parseInlineButtonsFromPayload(
  payload: Record<string, unknown> | null | undefined,
): InlineButtonRows | undefined {
  if (!payload) return undefined
  return validateInlineButtons(payload.inlineButtons)
}

/** Convert app-level buttons to the Telegram Bot API reply markup shape. */
export function toTelegramReplyMarkup(rows: InlineButtonRows): TelegramReplyMarkup {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((button) =>
        button.callbackData !== undefined
          ? { text: button.text, callback_data: button.callbackData }
          : { text: button.text, url: button.url ?? '' },
      ),
    ),
  }
}
