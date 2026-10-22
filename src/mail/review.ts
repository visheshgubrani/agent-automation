import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import type { DbSession } from '../db/index.js'
import { accounts, emailClassifications, messages, telegramMessages } from '../db/schema/index.js'

/** Bounded page size for Telegram review/search results. */
export const MAIL_REVIEW_PAGE_SIZE = 5
const MAX_PAGE = 10_000

export interface ReviewItem {
  messageId: string
  classificationId: string | null
  accountId: string
  accountEmail: string
  fromEmail: string
  fromName: string | null
  subject: string
  receivedAt: Date
  shouldNotify: boolean | null
  summary: string | null
  decisionSource: string | null
}

export interface ReviewPage {
  items: ReviewItem[]
  page: number
  hasNext: boolean
}

export interface ReviewPageOptions {
  page?: number
  pageSize?: number
}

export function clampReviewPage(page: number): number {
  if (!Number.isFinite(page)) return 0
  return Math.max(0, Math.min(MAX_PAGE, Math.trunc(page)))
}

function pageSizeOf(options: ReviewPageOptions): number {
  const value = options.pageSize ?? MAIL_REVIEW_PAGE_SIZE
  return Math.max(1, Math.min(10, Math.trunc(value)))
}

function reviewSelection() {
  return {
    messageId: messages.id,
    // The search path uses a left join, so classification fields are nullable there.
    classificationId: sql<string | null>`${emailClassifications.id}`,
    accountId: messages.accountId,
    accountEmail: accounts.emailAddress,
    fromEmail: messages.fromEmail,
    fromName: messages.fromName,
    subject: messages.subject,
    receivedAt: messages.receivedAt,
    shouldNotify: sql<boolean | null>`${emailClassifications.shouldNotify}`,
    summary: sql<string | null>`${emailClassifications.summary}`,
    decisionSource: sql<string | null>`${emailClassifications.decisionSource}`,
  }
}

function toReviewPage(rows: ReviewItem[], page: number, pageSize: number): ReviewPage {
  return {
    items: rows.slice(0, pageSize),
    page,
    hasNext: rows.length > pageSize,
  }
}

/**
 * Current ignored mail, newest first. "Ignored" means the current decision says not to notify;
 * it includes classifier, rule, and correction decisions.
 */
export async function listIgnoredMail(
  db: DbSession,
  options: ReviewPageOptions = {},
): Promise<ReviewPage> {
  const pageSize = pageSizeOf(options)
  const page = clampReviewPage(options.page ?? 0)

  const rows = await db
    .select(reviewSelection())
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .innerJoin(
      emailClassifications,
      and(
        eq(emailClassifications.messageId, messages.id),
        isNull(emailClassifications.supersededAt),
      ),
    )
    .where(eq(emailClassifications.shouldNotify, false))
    .orderBy(desc(messages.receivedAt), desc(messages.id))
    .limit(pageSize + 1)
    .offset(page * pageSize)

  return toReviewPage(rows, page, pageSize)
}

/**
 * Local stored-mail search over subject/clean text using the documented FTS expression, plus a
 * case-insensitive sender substring. Includes ignored and unclassified mail. The query is bounded
 * and parsed by `websearch_to_tsquery`, so user text cannot inject SQL or a tsquery error.
 */
export async function searchMail(
  db: DbSession,
  options: ReviewPageOptions & { query: string },
): Promise<ReviewPage> {
  const query = options.query.trim().slice(0, 200)
  const pageSize = pageSizeOf(options)
  const page = clampReviewPage(options.page ?? 0)
  if (query.length === 0) {
    return { items: [], page, hasNext: false }
  }

  const matchesBody = sql`to_tsvector('english', coalesce(${messages.subject}, '') || ' ' || ${messages.cleanText}) @@ websearch_to_tsquery('english', ${query})`
  const matchesSender = sql`position(lower(${query}) in lower(${messages.fromEmail})) > 0`

  const rows = await db
    .select(reviewSelection())
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .leftJoin(
      emailClassifications,
      and(
        eq(emailClassifications.messageId, messages.id),
        isNull(emailClassifications.supersededAt),
      ),
    )
    .where(or(matchesBody, matchesSender))
    .orderBy(desc(messages.receivedAt), desc(messages.id))
    .limit(pageSize + 1)
    .offset(page * pageSize)

  return toReviewPage(rows, page, pageSize)
}

export interface DisplayedClassification {
  classification: {
    id: string
    messageId: string
    runId: string
    topic: string
    shouldNotify: boolean
    summary: string | null
    reason: string | null
    decisionSource: string
    supersededAt: Date | null
    createdAt: Date
  }
  message: {
    id: string
    accountId: string
    providerMessageId: string
    rfcMessageId: string | null
    fromEmail: string
    fromName: string | null
    subject: string
    receivedAt: Date
  }
  account: {
    id: string
    emailAddress: string
  }
}

/** Load the classification shown to the user plus its message and receiving account. */
export async function loadDisplayedClassification(
  db: DbSession,
  classificationId: string,
): Promise<DisplayedClassification | undefined> {
  const [row] = await db
    .select({
      classification: {
        id: emailClassifications.id,
        messageId: emailClassifications.messageId,
        runId: emailClassifications.runId,
        topic: emailClassifications.topic,
        shouldNotify: emailClassifications.shouldNotify,
        summary: emailClassifications.summary,
        reason: emailClassifications.reason,
        decisionSource: emailClassifications.decisionSource,
        supersededAt: emailClassifications.supersededAt,
        createdAt: emailClassifications.createdAt,
      },
      message: {
        id: messages.id,
        accountId: messages.accountId,
        providerMessageId: messages.providerMessageId,
        rfcMessageId: messages.rfcMessageId,
        fromEmail: messages.fromEmail,
        fromName: messages.fromName,
        subject: messages.subject,
        receivedAt: messages.receivedAt,
      },
      account: {
        id: accounts.id,
        emailAddress: accounts.emailAddress,
      },
    })
    .from(emailClassifications)
    .innerJoin(messages, eq(messages.id, emailClassifications.messageId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(eq(emailClassifications.id, classificationId))
    .limit(1)
  return row
}

export type TelegramMessageRow = typeof telegramMessages.$inferSelect

/** Find the stored outbound bot message a callback is attached to. */
export async function findOutboundTelegramMessage(
  db: DbSession,
  chatId: string,
  telegramMessageId: number,
): Promise<TelegramMessageRow | undefined> {
  const [row] = await db
    .select()
    .from(telegramMessages)
    .where(
      and(
        eq(telegramMessages.chatId, chatId),
        eq(telegramMessages.telegramMessageId, telegramMessageId),
        eq(telegramMessages.direction, 'outbound'),
      ),
    )
    .limit(1)
  return row
}
