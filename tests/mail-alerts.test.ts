import { describe, expect, it } from 'vitest'
import {
  EMAIL_ALERT_BODY_LIMIT,
  emailTriageAlertButtons,
  gmailMessageUrl,
  maskAccountIdentifiers,
  redactOtpValues,
  renderEmailTriageAlert,
  sanitizeAlertText,
} from '../src/mail/alerts.js'
import {
  MAX_INLINE_BUTTON_ROWS,
  MAX_INLINE_BUTTONS_PER_ROW,
  parseInlineButtonsFromPayload,
  TELEGRAM_BUTTON_TEXT_LIMIT,
  TELEGRAM_CALLBACK_DATA_LIMIT,
  validateInlineButtons,
} from '../src/telegram/buttons.js'

const CLASSIFICATION_ID = '11111111-2222-4333-8444-555555555555'

describe('alert text sanitization', () => {
  it('redacts OTP values before and after their label', () => {
    expect(redactOtpValues('Your OTP is 123456 and it expires soon')).toBe(
      'Your OTP is [redacted] and it expires soon',
    )
    expect(redactOtpValues('984321 is your one-time password')).toBe(
      '[redacted] is your one-time password',
    )
    expect(redactOtpValues('Verification code: 555111')).toBe('Verification code: [redacted]')
    expect(redactOtpValues('Use passcode 778899 to sign in')).toBe(
      'Use passcode [redacted] to sign in',
    )
    expect(redactOtpValues('Use 456789 to verify your login')).toBe(
      'Use [redacted] to verify your login',
    )
  })

  it('leaves amounts and ordinary dates alone while masking card/account identifiers', () => {
    expect(maskAccountIdentifiers('Charged INR 1,234.56 on 2026-10-22')).toBe(
      'Charged INR 1,234.56 on 2026-10-22',
    )
    expect(maskAccountIdentifiers('Card 4111 1111 1111 1111 was charged')).toBe(
      'Card ••••1111 was charged',
    )
    expect(maskAccountIdentifiers('Account 123456789012 debited')).toBe('Account ••••9012 debited')
  })

  it('combines redaction and masking into one single-line field', () => {
    expect(sanitizeAlertText('Card 4111 1111 1111 1111 charged\nUse OTP 123456 to confirm')).toBe(
      'Card ••••1111 charged Use OTP [redacted] to confirm',
    )
  })

  it('builds an account-scoped Gmail search link', () => {
    expect(gmailMessageUrl('me@example.test', '18f2abcd9')).toBe(
      'https://mail.google.com/mail/u/?authuser=me%40example.test#all/18f2abcd9',
    )
  })
})

describe('renderEmailTriageAlert', () => {
  const base = {
    accountEmail: 'work@example.test',
    fromEmail: 'alerts@bank.test',
    fromName: 'Bank Alerts',
    subject: 'Debit alert',
    summary: 'A debit of INR 500 posted to your account ending 1234.',
    reason: 'Bank transaction alert that needs attention.',
    gmailUrl: gmailMessageUrl('work@example.test', 'provider-1'),
  }

  it('includes the source account, sender, subject, summary, reason, and Gmail link', () => {
    const body = renderEmailTriageAlert(base)
    expect(body).toContain('Important email')
    expect(body).toContain('Account: work@example.test')
    expect(body).toContain('From: Bank Alerts <alerts@bank.test>')
    expect(body).toContain('Subject: Debit alert')
    expect(body).toContain('Summary: A debit of INR 500 posted')
    expect(body).toContain('Why: Bank transaction alert')
    expect(body).toContain(`Open in Gmail: ${base.gmailUrl}`)
  })

  it('masks identifiers and never includes OTP values', () => {
    const body = renderEmailTriageAlert({
      ...base,
      summary: 'Card 4111 1111 1111 1111 was charged. OTP 998877 expires in 10 minutes.',
    })
    expect(body).toContain('••••1111')
    expect(body).not.toContain('4111 1111 1111 1111')
    expect(body).not.toContain('998877')
    expect(body).toContain('[redacted]')
  })

  it('falls back for rule alerts without a summary and stays bounded', () => {
    const body = renderEmailTriageAlert({
      ...base,
      summary: null,
      reason: null,
      subject: 'x'.repeat(10_000),
      fromName: 'y'.repeat(10_000),
    })
    expect(body).toContain('Summary: No summary available.')
    expect(body).toContain('Why: Classified as important.')
    expect(body.length).toBeLessThanOrEqual(EMAIL_ALERT_BODY_LIMIT)
    expect(body).toContain('Open in Gmail:')
  })
})

describe('alert inline buttons', () => {
  it('uses callback data that fits Telegram limits and references the classification', () => {
    const rows = emailTriageAlertButtons(CLASSIFICATION_ID)
    expect(rows.flat().map((button) => button.text)).toEqual([
      'Useful',
      'Not important',
      'Create rule',
    ])
    for (const button of rows.flat()) {
      expect(Buffer.byteLength(button.callbackData, 'utf8')).toBeLessThanOrEqual(
        TELEGRAM_CALLBACK_DATA_LIMIT,
      )
      expect(button.callbackData).toContain(CLASSIFICATION_ID)
    }
    expect(validateInlineButtons(rows)).toEqual(rows)
  })

  it('rejects malformed, oversized, or unbounded keyboards', () => {
    expect(validateInlineButtons(undefined)).toBeUndefined()
    expect(validateInlineButtons([])).toBeUndefined()
    expect(validateInlineButtons([{ text: 'x', callbackData: 'y' }])).toBeUndefined()
    expect(validateInlineButtons([[{ text: '', callbackData: 'x' }]])).toBeUndefined()
    expect(
      validateInlineButtons([
        [{ text: 'x'.repeat(TELEGRAM_BUTTON_TEXT_LIMIT + 1), callbackData: 'x' }],
      ]),
    ).toBeUndefined()
    expect(
      validateInlineButtons([
        [{ text: 'x', callbackData: 'x'.repeat(TELEGRAM_CALLBACK_DATA_LIMIT + 1) }],
      ]),
    ).toBeUndefined()

    const tooManyRows = Array.from({ length: MAX_INLINE_BUTTON_ROWS + 1 }, () => [
      { text: 'x', callbackData: 'x' },
    ])
    expect(validateInlineButtons(tooManyRows)).toBeUndefined()

    const tooManyButtons = [
      Array.from({ length: MAX_INLINE_BUTTONS_PER_ROW + 1 }, () => ({
        text: 'x',
        callbackData: 'x',
      })),
    ]
    expect(validateInlineButtons(tooManyButtons)).toBeUndefined()
  })

  it('parses only the validated payload field', () => {
    const rows = emailTriageAlertButtons(CLASSIFICATION_ID)
    expect(parseInlineButtonsFromPayload({ inlineButtons: rows })).toEqual(rows)
    expect(parseInlineButtonsFromPayload({ inlineButtons: 'nope' })).toBeUndefined()
    expect(parseInlineButtonsFromPayload({})).toBeUndefined()
    expect(parseInlineButtonsFromPayload(null)).toBeUndefined()
  })
})
