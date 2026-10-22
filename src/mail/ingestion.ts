import { and, eq, inArray } from 'drizzle-orm'
import type { DbSession } from '../db/index.js'
import { messages } from '../db/schema/index.js'
import { isExcludedMessage, type ParsedGmailMessage } from './mime.js'

export interface IngestedMessage {
  id: string
  providerMessageId: string
}

/**
 * Idempotent message upsert. New rows start `pending`; replay only refreshes provider
 * labels/thread, so an already classified message is never reset by a replayed sync page.
 * Excluded labels (spam/trash/draft/sent) are skipped before insert.
 */
export async function upsertParsedMessage(
  db: DbSession,
  accountId: string,
  parsed: ParsedGmailMessage,
  now: Date = new Date(),
): Promise<IngestedMessage | undefined> {
  if (isExcludedMessage(parsed.providerLabels)) return undefined

  const [row] = await db
    .insert(messages)
    .values({
      accountId,
      providerMessageId: parsed.providerMessageId,
      providerThreadId: parsed.providerThreadId,
      rfcMessageId: parsed.rfcMessageId,
      fromEmail: parsed.fromEmail,
      fromName: parsed.fromName,
      toEmails: parsed.toEmails,
      ccEmails: parsed.ccEmails,
      subject: parsed.subject,
      receivedAt: parsed.receivedAt,
      providerLabels: parsed.providerLabels,
      rawText: parsed.rawText,
      rawContentType: parsed.rawContentType,
      cleanText: parsed.cleanText,
      cleanerVersion: parsed.cleanerVersion,
      headers: parsed.headers,
      triageStatus: 'pending',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [messages.accountId, messages.providerMessageId],
      set: {
        providerLabels: parsed.providerLabels,
        providerThreadId: parsed.providerThreadId,
        updatedAt: now,
      },
    })
    .returning({ id: messages.id, providerMessageId: messages.providerMessageId })

  return row
}

export async function upsertParsedMessages(
  db: DbSession,
  accountId: string,
  parsedMessages: readonly ParsedGmailMessage[],
  now: Date = new Date(),
): Promise<number> {
  let count = 0
  for (const parsed of parsedMessages) {
    const row = await upsertParsedMessage(db, accountId, parsed, now)
    if (row) count += 1
  }
  return count
}

export interface StoredMessageLabels {
  id: string
  providerMessageId: string
  providerLabels: string[]
}

/** Load labels for the messages a history page references, in one query. */
export async function loadStoredMessageLabels(
  db: DbSession,
  accountId: string,
  providerMessageIds: readonly string[],
): Promise<StoredMessageLabels[]> {
  const ids = [...new Set(providerMessageIds)]
  if (ids.length === 0) return []
  return db
    .select({
      id: messages.id,
      providerMessageId: messages.providerMessageId,
      providerLabels: messages.providerLabels,
    })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), inArray(messages.providerMessageId, ids)))
}

export async function updateMessageLabels(
  db: DbSession,
  id: string,
  labels: string[],
  now: Date,
): Promise<void> {
  await db
    .update(messages)
    .set({ providerLabels: [...new Set(labels)].sort(), updatedAt: now })
    .where(eq(messages.id, id))
}
