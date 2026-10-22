import { and, desc, eq, isNull } from 'drizzle-orm'
import type { DbSession } from '../db/index.js'
import {
  accounts,
  classificationFeedback,
  emailClassifications,
  mailboxSyncState,
  messages,
  notificationOutbox,
} from '../db/schema/index.js'
import { emailTriageDedupeKey } from '../notifications/dedupe.js'
import {
  enqueueNotification,
  findNotificationByDedupeKey,
  type NotificationRow,
} from '../notifications/outbox.js'
import type { InlineButtonRows } from '../telegram/buttons.js'
import { feedbackExampleTarget } from './examples.js'

/** Hard bound for an alert body; well below Telegram's 4096-character message cap. */
export const EMAIL_ALERT_BODY_LIMIT = 1_500
const METADATA_FIELD_LIMIT = 200
const SUMMARY_FIELD_LIMIT = 400
const REASON_FIELD_LIMIT = 240

const OTP_LABEL =
  '(?:otp|o\\.t\\.p\\.?|one[\\s-]?time(?:[\\s-]?(?:password|passcode|code|pin))?|verification\\s+(?:code|pin)|security\\s+code|login\\s+code|passcode|2fa\\s+code|authentication\\s+code|access\\s+code)'
const OTP_BEFORE_CODE = new RegExp(`((?:\\b${OTP_LABEL}\\b)[^\\n]{0,80}?)\\b\\d{3,8}\\b`, 'gi')
const CODE_BEFORE_OTP = new RegExp(
  `\\b\\d{3,8}\\b(?=\\s+(?:is|as)\\s+(?:your|the)?\\s*${OTP_LABEL}\\b)`,
  'gi',
)
const CODE_TOKEN = /\b(code|pin|passcode)\b\s*(?:is|:)?\s*\d{3,8}\b/gi
const CODE_FOR_ACTION =
  /\b\d{3,8}\b(?=\s+(?:to|for)\s+(?:verify|sign in|log in|confirm|complete|reset))/gi
const LONG_IDENTIFIER = /(?<!\d)(?:\d[ -]?){9,18}\d(?!\d)/g

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clip(value: string, limit: number): string {
  if (limit <= 0) return ''
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

/**
 * Remove likely one-time-code values while keeping the surrounding sentence. Codes are only
 * redacted near OTP/verification/passcode wording, so unrelated transaction numbers survive.
 */
export function redactOtpValues(text: string): string {
  return text
    .replace(OTP_BEFORE_CODE, '$1[redacted]')
    .replace(CODE_BEFORE_OTP, '[redacted]')
    .replace(CODE_TOKEN, '$1: [redacted]')
    .replace(CODE_FOR_ACTION, '[redacted]')
}

/** Mask long card/account digit runs, keeping only the last four digits. */
export function maskAccountIdentifiers(text: string): string {
  return text.replace(LONG_IDENTIFIER, (match) => {
    const digits = match.replace(/\D/g, '')
    return digits.length >= 10 ? `••••${digits.slice(-4)}` : match
  })
}

/** Alert-safe single-line text: compact, OTP-redacted, and account/card-masked. */
export function sanitizeAlertText(text: string): string {
  return maskAccountIdentifiers(redactOtpValues(compact(text)))
}

/** Open the message in the receiving account's Gmail (search-all, so archived mail works). */
export function gmailMessageUrl(accountEmail: string, providerMessageId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(accountEmail)}#all/${encodeURIComponent(providerMessageId)}`
}

/** Inline buttons for an alert; callback payloads stay within Telegram's 64-byte limit. */
export function emailTriageAlertButtons(classificationId: string): InlineButtonRows {
  return [
    [
      { text: 'Useful', callbackData: `mail:useful:${classificationId}` },
      { text: 'Not important', callbackData: `mail:not_important:${classificationId}` },
    ],
    [{ text: 'Create rule', callbackData: `mail:create_rule:${classificationId}` }],
  ]
}

export interface EmailTriageAlertInput {
  accountEmail: string
  fromEmail: string
  fromName: string | null
  subject: string
  summary: string | null
  reason: string | null
  gmailUrl: string
}

/** Render a bounded plain-text alert from bounded stored fields only. */
export function renderEmailTriageAlert(input: EmailTriageAlertInput): string {
  const sender = input.fromName
    ? `${sanitizeAlertText(input.fromName)} <${sanitizeAlertText(input.fromEmail)}>`
    : sanitizeAlertText(input.fromEmail)
  const header = [
    'Important email',
    `Account: ${clip(sanitizeAlertText(input.accountEmail), METADATA_FIELD_LIMIT)}`,
    `From: ${clip(sender, METADATA_FIELD_LIMIT)}`,
    `Subject: ${clip(sanitizeAlertText(input.subject), METADATA_FIELD_LIMIT) || '(no subject)'}`,
  ].join('\n')
  const link = `Open in Gmail: ${input.gmailUrl}`

  const available = Math.max(0, EMAIL_ALERT_BODY_LIMIT - header.length - link.length - 24)
  const summaryMax = Math.max(0, Math.min(SUMMARY_FIELD_LIMIT, Math.floor(available * 0.65)))
  const reasonMax = Math.max(0, Math.min(REASON_FIELD_LIMIT, available - summaryMax))
  const summary = clip(
    sanitizeAlertText(input.summary ?? '') || 'No summary available.',
    summaryMax,
  )
  const reason = clip(
    sanitizeAlertText(input.reason ?? '') || 'Classified as important.',
    reasonMax,
  )

  const sections = [header]
  if (summary.length > 0) sections.push(`Summary: ${summary}`)
  if (reason.length > 0) sections.push(`Why: ${reason}`)
  sections.push(link)

  const body = sections.join('\n')
  return body.length <= EMAIL_ALERT_BODY_LIMIT
    ? body
    : `${body.slice(0, EMAIL_ALERT_BODY_LIMIT - 1).trimEnd()}…`
}

export interface EmailTriageAlertPayload extends Record<string, unknown> {
  version: 1
  messageId: string
  accountId: string
  gmailUrl: string
  inlineButtons: InlineButtonRows
}

interface MessageAlertContext {
  messageId: string
  accountId: string
  providerMessageId: string
  rfcMessageId: string | null
  fromEmail: string
  fromName: string | null
  subject: string
  receivedAt: Date
  accountEmail: string
  notificationBoundaryAt: Date | null
}

interface CanonicalCorrection {
  shouldNotify: boolean
  reason: string | null
  at: Date
}

async function loadMessageContext(
  db: DbSession,
  messageId: string,
): Promise<MessageAlertContext | undefined> {
  const [row] = await db
    .select({
      messageId: messages.id,
      accountId: messages.accountId,
      providerMessageId: messages.providerMessageId,
      rfcMessageId: messages.rfcMessageId,
      fromEmail: messages.fromEmail,
      fromName: messages.fromName,
      subject: messages.subject,
      receivedAt: messages.receivedAt,
      accountEmail: accounts.emailAddress,
      notificationBoundaryAt: mailboxSyncState.notificationBoundaryAt,
    })
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .leftJoin(mailboxSyncState, eq(mailboxSyncState.accountId, messages.accountId))
    .where(eq(messages.id, messageId))
    .limit(1)
  return row
}

/**
 * The most recent explicit correction for the canonical email. A correction classification
 * wins over feedback when it is at least as new; otherwise the latest feedback label decides.
 * Messages without an RFC Message-ID are scoped to the stored message alone.
 */
async function loadCanonicalCorrection(
  db: DbSession,
  context: Pick<MessageAlertContext, 'messageId' | 'rfcMessageId'>,
): Promise<CanonicalCorrection | undefined> {
  const scope =
    context.rfcMessageId === null
      ? eq(messages.id, context.messageId)
      : eq(messages.rfcMessageId, context.rfcMessageId)

  const [correction] = await db
    .select({
      shouldNotify: emailClassifications.shouldNotify,
      reason: emailClassifications.reason,
      at: emailClassifications.createdAt,
    })
    .from(emailClassifications)
    .innerJoin(messages, eq(messages.id, emailClassifications.messageId))
    .where(
      and(
        eq(emailClassifications.decisionSource, 'correction'),
        isNull(emailClassifications.supersededAt),
        scope,
      ),
    )
    .orderBy(desc(emailClassifications.createdAt), desc(emailClassifications.id))
    .limit(1)

  const [feedback] = await db
    .select({
      rating: classificationFeedback.rating,
      reason: classificationFeedback.reason,
      note: classificationFeedback.note,
      shouldNotify: emailClassifications.shouldNotify,
      at: classificationFeedback.updatedAt,
    })
    .from(classificationFeedback)
    .innerJoin(
      emailClassifications,
      eq(emailClassifications.id, classificationFeedback.classificationId),
    )
    .innerJoin(messages, eq(messages.id, emailClassifications.messageId))
    .where(scope)
    .orderBy(desc(classificationFeedback.updatedAt), desc(classificationFeedback.id))
    .limit(1)

  if (!correction) {
    if (!feedback) return undefined
    return {
      shouldNotify: feedbackExampleTarget(feedback),
      reason: feedback.note,
      at: feedback.at,
    }
  }

  if (feedback && feedback.at.getTime() > correction.at.getTime()) {
    return {
      shouldNotify: feedbackExampleTarget(feedback),
      reason: feedback.note,
      at: feedback.at,
    }
  }

  return correction
}

export type EmailAlertOutcome =
  | 'enqueued'
  | 'reactivated'
  | 'duplicate'
  | 'not_important'
  | 'before_boundary'
  | 'missing_message'

export interface ProduceEmailAlertResult {
  outcome: EmailAlertOutcome
  notification?: NotificationRow
}

export interface ProduceEmailAlertInput {
  messageId: string
  classification: {
    id: string
    shouldNotify: boolean
    summary: string | null
    reason: string | null
  }
  /**
   * Explicit missed-important corrections may alert mail received before the account's
   * connection boundary. Automatic classification never sets this.
   */
  allowBeforeBoundary?: boolean
}

/**
 * Produce one canonical email-triage outbox row. Runs inside the classification transaction so
 * the current classification, message status, and notification commit together.
 *
 * Precedence: canonical correction → boundary → this classification's shouldNotify. A canonical
 * correction that says "important" also overrides the silent boundary, because it records an
 * explicit user decision; a canonical "not important" correction suppresses the alert.
 */
export async function produceEmailTriageAlert(
  db: DbSession,
  input: ProduceEmailAlertInput,
): Promise<ProduceEmailAlertResult> {
  const context = await loadMessageContext(db, input.messageId)
  if (!context) return { outcome: 'missing_message' }

  const correction = await loadCanonicalCorrection(db, context)
  const shouldNotify = correction?.shouldNotify ?? input.classification.shouldNotify
  if (!shouldNotify) return { outcome: 'not_important' }

  const beforeBoundary =
    context.notificationBoundaryAt === null || context.receivedAt <= context.notificationBoundaryAt
  const correctedImportant = correction?.shouldNotify === true
  if (beforeBoundary && input.allowBeforeBoundary !== true && !correctedImportant) {
    return { outcome: 'before_boundary' }
  }

  const gmailUrl = gmailMessageUrl(context.accountEmail, context.providerMessageId)
  const body = renderEmailTriageAlert({
    accountEmail: context.accountEmail,
    fromEmail: context.fromEmail,
    fromName: context.fromName,
    subject: context.subject,
    summary: input.classification.summary,
    reason:
      correctedImportant && !input.classification.shouldNotify
        ? (correction.reason ?? 'You marked this email as important.')
        : input.classification.reason,
    gmailUrl,
  })

  const payload: EmailTriageAlertPayload = {
    version: 1,
    messageId: context.messageId,
    accountId: context.accountId,
    gmailUrl,
    inlineButtons: emailTriageAlertButtons(input.classification.id),
  }
  const dedupeKey = emailTriageDedupeKey({
    rfcMessageId: context.rfcMessageId,
    messageId: context.messageId,
  })

  const existing = await findNotificationByDedupeKey(db, dedupeKey)
  if (existing) {
    const canReactivate =
      existing.status === 'cancelled' ||
      (input.allowBeforeBoundary === true &&
        (existing.status === 'failed' || existing.status === 'expired'))
    if (canReactivate) {
      const now = new Date()
      const [reactivated] = await db
        .update(notificationOutbox)
        .set({
          status: 'pending',
          classificationId: input.classification.id,
          body,
          payload,
          scheduledFor: now,
          expiresAt: null,
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
          sentAt: null,
          telegramMessageId: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(notificationOutbox.id, existing.id),
            eq(notificationOutbox.status, existing.status),
          ),
        )
        .returning()
      if (reactivated) {
        return { outcome: 'reactivated', notification: reactivated }
      }
    }
    return { outcome: 'duplicate', notification: existing }
  }

  const result = await enqueueNotification(db, {
    kind: 'email_triage',
    dedupeKey,
    body,
    payload,
    classificationId: input.classification.id,
  })

  return result.inserted
    ? { outcome: 'enqueued', notification: result.notification }
    : { outcome: 'duplicate', notification: result.notification }
}
