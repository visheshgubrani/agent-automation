import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { classifierFeedbackExamples } from '../db/schema/index.js'

export const MAX_FEEDBACK_EXAMPLES = 6
export const FEEDBACK_EXAMPLE_EXCERPT_CHARS = 600

export interface FeedbackExample {
  messageId: string
  fromEmail: string
  subject: string
  excerpt: string
  shouldNotify: boolean
  reason: string | null
  note: string | null
  labeledAt: Date
}

function senderDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1)
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * The corrected decision for one feedback label. A missed-important label is positive even
 * when it was attached to an ignored message; `not_useful` is negative; `useful` is positive.
 */
export function feedbackExampleTarget(row: {
  rating: string
  reason: string | null
  shouldNotify: boolean
}): boolean {
  if (row.reason === 'missed_important') return true
  // A category correction does not assert that the alert decision was wrong.
  if (row.reason === 'wrong_category') return row.shouldNotify
  if (row.rating === 'useful') return true
  if (row.rating === 'not_useful') return false
  return row.shouldNotify
}

export interface LoadFeedbackExamplesOptions {
  limit?: number
}

/**
 * Small, bounded set of relevant past corrections. Same-sender and same-domain examples come
 * first, then recent labels. The current message and stored copies with the same normalized
 * RFC Message-ID are excluded so a message is never its own example.
 */
export async function loadFeedbackExamples(
  db: Db,
  message: { id: string; rfcMessageId: string | null; fromEmail: string },
  options: LoadFeedbackExamplesOptions = {},
): Promise<FeedbackExample[]> {
  const limit = Math.min(MAX_FEEDBACK_EXAMPLES, Math.max(1, options.limit ?? MAX_FEEDBACK_EXAMPLES))
  const sameEmail =
    message.rfcMessageId === null
      ? undefined
      : or(
          isNull(classifierFeedbackExamples.rfc_message_id),
          ne(classifierFeedbackExamples.rfc_message_id, message.rfcMessageId),
        )

  const sender = message.fromEmail.trim().toLowerCase()
  const domain = senderDomain(sender)
  const baseWhere = and(ne(classifierFeedbackExamples.message_id, message.id), sameEmail)
  const relevantWhere = and(
    baseWhere,
    or(
      eq(sql`lower(${classifierFeedbackExamples.from_email})`, sender),
      eq(sql`split_part(lower(${classifierFeedbackExamples.from_email}), '@', 2)`, domain),
    ),
  )

  const selectExamples = () =>
    db
      .select({
        messageId: classifierFeedbackExamples.message_id,
        rating: classifierFeedbackExamples.rating,
        reason: classifierFeedbackExamples.reason,
        note: classifierFeedbackExamples.note,
        shouldNotify: classifierFeedbackExamples.should_notify,
        fromEmail: classifierFeedbackExamples.from_email,
        subject: classifierFeedbackExamples.subject,
        cleanText: classifierFeedbackExamples.clean_text,
        labeledAt: classifierFeedbackExamples.labeled_at,
      })
      .from(classifierFeedbackExamples)

  const [relevant, recent] = await Promise.all([
    selectExamples()
      .where(relevantWhere)
      .orderBy(desc(classifierFeedbackExamples.labeled_at))
      .limit(limit * 4),
    selectExamples()
      .where(baseWhere)
      .orderBy(desc(classifierFeedbackExamples.labeled_at))
      .limit(limit * 4),
  ])

  const seen = new Set<string>()
  const ranked = [...relevant, ...recent]
    .filter((row) => {
      if (seen.has(row.messageId)) return false
      seen.add(row.messageId)
      return true
    })
    .map((row) => {
      const email = row.fromEmail.trim().toLowerCase()
      const relevance = email === sender ? 0 : senderDomain(email) === domain ? 1 : 2
      return { row, relevance }
    })
    .sort(
      (a, b) => a.relevance - b.relevance || b.row.labeledAt.getTime() - a.row.labeledAt.getTime(),
    )
    .slice(0, limit)

  return ranked.map(({ row }) => ({
    messageId: row.messageId,
    fromEmail: row.fromEmail,
    subject: compact(row.subject).slice(0, 200),
    excerpt: compact(row.cleanText).slice(0, FEEDBACK_EXAMPLE_EXCERPT_CHARS),
    shouldNotify: feedbackExampleTarget(row),
    reason: row.reason,
    note: row.note === null ? null : compact(row.note).slice(0, 200),
    labeledAt: row.labeledAt,
  }))
}
