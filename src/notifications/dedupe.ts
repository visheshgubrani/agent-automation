/**
 * Normalize an RFC Message-ID header for cross-inbox comparison. Accepts an optional
 * surrounding angle-bracket form (`<id@example.com>`), ignores trailing comments or a
 * second id, trims whitespace, and leaves the id itself case-sensitive.
 */
export function normalizeRfcMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null

  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  const bracketed = /<([^<>]+)>/.exec(trimmed)
  const value = (bracketed?.[1] ?? trimmed).trim()
  return value.length > 0 ? value : null
}

export interface EmailIdentity {
  rfcMessageId: string | null
  /** Stable stored `messages.id`; used only when the RFC Message-ID is missing. */
  messageId: string
}

/**
 * Canonical email-triage outbox key. The RFC Message-ID collapses the same email arriving
 * in several inboxes. Without that header, the stored message identity is the fallback so
 * reclassification (which creates a new classification id) cannot notify twice.
 */
export function emailTriageDedupeKey(identity: EmailIdentity): string {
  const normalized = normalizeRfcMessageId(identity.rfcMessageId)
  if (normalized !== null) {
    return `email_triage:rfc:${normalized}`
  }

  const messageId = identity.messageId.trim()
  if (messageId.length === 0) {
    throw new Error('emailTriageDedupeKey requires a non-empty message id fallback')
  }
  return `email_triage:message:${messageId}`
}
