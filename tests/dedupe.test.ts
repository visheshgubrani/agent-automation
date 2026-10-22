import { describe, expect, it } from 'vitest'
import { emailTriageDedupeKey, normalizeRfcMessageId } from '../src/notifications/dedupe.js'

describe('normalizeRfcMessageId', () => {
  it('trims whitespace and one surrounding bracket pair', () => {
    expect(normalizeRfcMessageId('  <message-1@example.test> ')).toBe('message-1@example.test')
    expect(normalizeRfcMessageId('message-2@example.test')).toBe('message-2@example.test')
  })

  it('extracts the first bracketed id and ignores trailing comments', () => {
    expect(normalizeRfcMessageId('<first@example.test> (comment) <second@example.test>')).toBe(
      'first@example.test',
    )
  })

  it('returns null for missing or empty values and preserves case', () => {
    expect(normalizeRfcMessageId(undefined)).toBeNull()
    expect(normalizeRfcMessageId(null)).toBeNull()
    expect(normalizeRfcMessageId('   ')).toBeNull()
    expect(normalizeRfcMessageId('< >')).toBeNull()
    expect(normalizeRfcMessageId('<CaseSensitive@Example.test>')).toBe('CaseSensitive@Example.test')
  })
})

describe('emailTriageDedupeKey', () => {
  it('prefers the normalized RFC Message-ID for cross-inbox collapse', () => {
    expect(
      emailTriageDedupeKey({ rfcMessageId: '<same@example.test>', messageId: 'message-a' }),
    ).toBe('email_triage:rfc:same@example.test')
    expect(
      emailTriageDedupeKey({ rfcMessageId: ' same@example.test ', messageId: 'message-b' }),
    ).toBe('email_triage:rfc:same@example.test')
  })

  it('falls back to stable stored message identity when the header is missing', () => {
    expect(emailTriageDedupeKey({ rfcMessageId: null, messageId: 'message-a' })).toBe(
      'email_triage:message:message-a',
    )
    expect(emailTriageDedupeKey({ rfcMessageId: '  ', messageId: 'message-a' })).toBe(
      'email_triage:message:message-a',
    )
  })

  it('rejects an empty fallback message id', () => {
    expect(() => emailTriageDedupeKey({ rfcMessageId: null, messageId: ' ' })).toThrow(
      /message id fallback/,
    )
  })
})
