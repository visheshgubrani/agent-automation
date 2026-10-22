import { and, eq, isNull, sql } from 'drizzle-orm'
import type { ReasoningEffort } from '../audit/calls.js'
import type { Db, DbSession } from '../db/index.js'
import { accounts, emailClassifications, type MailRuleRow, messages } from '../db/schema/index.js'
import { produceEmailTriageAlert } from './alerts.js'
import type { ClassifierOutput, PromptMessage } from './classifier-prompt.js'

export interface TriageMessage extends PromptMessage {
  id: string
  accountId: string
  providerMessageId: string
  rfcMessageId: string | null
}

/** Load only the clean, prompt-facing body plus bounded metadata for one claimed message. */
export async function loadTriageMessage(
  db: DbSession,
  id: string,
): Promise<TriageMessage | undefined> {
  const [row] = await db
    .select({
      id: messages.id,
      accountId: messages.accountId,
      providerMessageId: messages.providerMessageId,
      rfcMessageId: messages.rfcMessageId,
      fromEmail: messages.fromEmail,
      fromName: messages.fromName,
      toEmails: messages.toEmails,
      ccEmails: messages.ccEmails,
      subject: messages.subject,
      receivedAt: messages.receivedAt,
      cleanText: messages.cleanText,
      headers: messages.headers,
      accountEmail: accounts.emailAddress,
    })
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(eq(messages.id, id))
    .limit(1)

  return row
}

export interface ClassifierDecisionInput {
  messageId: string
  runId: string
  decision: ClassifierOutput
  model: string
  promptVersion: string
  classifierVersion: string
  reasoningEffort: ReasoningEffort
  now?: Date
}

async function insertCurrentClassification(
  db: DbSession,
  values: typeof emailClassifications.$inferInsert,
  now: Date,
): Promise<typeof emailClassifications.$inferSelect> {
  await db
    .update(emailClassifications)
    .set({ supersededAt: sql`greatest(${now}, ${emailClassifications.createdAt})` })
    .where(
      and(
        eq(emailClassifications.messageId, values.messageId),
        isNull(emailClassifications.supersededAt),
      ),
    )

  const [row] = await db.insert(emailClassifications).values(values).returning()
  if (!row) throw new Error('failed to insert the current email classification')

  await db
    .update(messages)
    .set({
      triageStatus: 'classified',
      triageNextAttemptAt: null,
      triageLastError: null,
      updatedAt: now,
    })
    .where(eq(messages.id, values.messageId))

  return row
}

/** Current classification for a message, if any. */
export async function loadCurrentClassification(
  db: DbSession,
  messageId: string,
): Promise<typeof emailClassifications.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(emailClassifications)
    .where(
      and(eq(emailClassifications.messageId, messageId), isNull(emailClassifications.supersededAt)),
    )
    .limit(1)
  return row
}

/** Serialize decision insertion with a concurrent Telegram correction for the same message. */
async function lockMessageRow(db: DbSession, messageId: string): Promise<void> {
  await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, messageId))
    .for('update')
}

/**
 * A message correction is the highest-precedence decision. If one is current, a classifier or
 * rule decision must not supersede it (including a classification that was in flight when the
 * user corrected the mail).
 */
async function currentCorrection(
  db: DbSession,
  messageId: string,
): Promise<typeof emailClassifications.$inferSelect | undefined> {
  const current = await loadCurrentClassification(db, messageId)
  return current?.decisionSource === 'correction' ? current : undefined
}

/**
 * Append one classifier decision and produce its notification inside the caller's transaction.
 * Confidence is stored as diagnostics only; it never changes shouldNotify here.
 */
export async function recordClassifierDecisionInTransaction(
  db: DbSession,
  input: ClassifierDecisionInput,
): Promise<typeof emailClassifications.$inferSelect> {
  await lockMessageRow(db, input.messageId)
  const correction = await currentCorrection(db, input.messageId)
  if (correction) return correction

  const now = input.now ?? new Date()
  const row = await insertCurrentClassification(
    db,
    {
      messageId: input.messageId,
      runId: input.runId,
      category: input.decision.category,
      topic: input.decision.topic,
      shouldNotify: input.decision.shouldNotify,
      confidence: input.decision.confidence.toFixed(3),
      summary: input.decision.summary,
      reason: input.decision.reason,
      decisionSource: 'classifier',
      appliedRuleId: null,
      reasoningEffort: input.reasoningEffort,
      model: input.model,
      promptVersion: input.promptVersion,
      classifierVersion: input.classifierVersion,
      createdAt: now,
    },
    now,
  )

  await produceEmailTriageAlert(db, {
    messageId: input.messageId,
    classification: {
      id: row.id,
      shouldNotify: row.shouldNotify,
      summary: row.summary,
      reason: row.reason,
    },
  })
  return row
}

/** Transaction-owning wrapper used by the triage job. */
export async function recordClassifierDecision(
  db: Db,
  input: ClassifierDecisionInput,
): Promise<typeof emailClassifications.$inferSelect> {
  return db.transaction((tx) => recordClassifierDecisionInTransaction(tx, input))
}

/** A rule decision records provenance without pretending a model call or urgency judgment. */
export async function recordRuleDecisionInTransaction(
  db: DbSession,
  input: {
    messageId: string
    runId: string
    rule: MailRuleRow
    now?: Date
  },
): Promise<typeof emailClassifications.$inferSelect> {
  await lockMessageRow(db, input.messageId)
  const correction = await currentCorrection(db, input.messageId)
  if (correction) return correction

  const now = input.now ?? new Date()
  const condition =
    input.rule.subjectContains === null
      ? ''
      : ` and subject contains "${input.rule.subjectContains}"`
  const reason =
    `Matched ${input.rule.action} rule for ${input.rule.matchType} ${input.rule.matchValue}${condition}`.slice(
      0,
      200,
    )

  const row = await insertCurrentClassification(
    db,
    {
      messageId: input.messageId,
      runId: input.runId,
      category: null,
      topic: 'other',
      shouldNotify: input.rule.action === 'notify',
      confidence: null,
      summary: null,
      reason,
      decisionSource: 'rule',
      appliedRuleId: input.rule.id,
      reasoningEffort: null,
      model: null,
      promptVersion: null,
      classifierVersion: null,
      createdAt: now,
    },
    now,
  )

  await produceEmailTriageAlert(db, {
    messageId: input.messageId,
    classification: {
      id: row.id,
      shouldNotify: row.shouldNotify,
      summary: row.summary,
      reason: row.reason,
    },
  })
  return row
}

/** Transaction-owning wrapper used by the triage job. */
export async function recordRuleDecision(
  db: Db,
  input: {
    messageId: string
    runId: string
    rule: MailRuleRow
    now?: Date
  },
): Promise<typeof emailClassifications.$inferSelect> {
  return db.transaction((tx) => recordRuleDecisionInTransaction(tx, input))
}

export interface CorrectionDecisionInput {
  messageId: string
  runId: string
  shouldNotify: boolean
  topic?: typeof emailClassifications.$inferSelect.topic
  summary?: string | null
  reason?: string
  now?: Date
}

export interface CorrectionDecisionResult {
  classification: typeof emailClassifications.$inferSelect
  /** False when the current correction already has the requested direction. */
  inserted: boolean
}

/**
 * Insert a correction decision for one stored copy, inside the caller's transaction. Repeating
 * the same direction is idempotent; changing direction appends a new correction row and keeps
 * history. The caller is responsible for applying the correction across canonical copies.
 */
export async function recordCorrectionDecisionInTransaction(
  db: DbSession,
  input: CorrectionDecisionInput,
): Promise<CorrectionDecisionResult> {
  await lockMessageRow(db, input.messageId)
  const now = input.now ?? new Date()
  const current = await loadCurrentClassification(db, input.messageId)
  if (current?.decisionSource === 'correction' && current.shouldNotify === input.shouldNotify) {
    return { classification: current, inserted: false }
  }

  const reason =
    input.reason ??
    (input.shouldNotify ? 'Marked important from Telegram' : 'Marked not important from Telegram')
  const row = await insertCurrentClassification(
    db,
    {
      messageId: input.messageId,
      runId: input.runId,
      category: null,
      topic: input.topic ?? current?.topic ?? 'other',
      shouldNotify: input.shouldNotify,
      confidence: null,
      summary: input.summary ?? current?.summary ?? null,
      reason: reason.slice(0, 200),
      decisionSource: 'correction',
      appliedRuleId: null,
      reasoningEffort: null,
      model: null,
      promptVersion: null,
      classifierVersion: null,
      createdAt: now,
    },
    now,
  )
  return { classification: row, inserted: true }
}
