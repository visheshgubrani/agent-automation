import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { mailboxSyncState, mailRules, messages } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'

export const MAX_TRIAGE_ATTEMPTS = 5
/**
 * Longer than the maximum bounded batch (5 calls at the 5-minute timeout ceiling), so a live
 * triage job cannot have its claims recovered and processed a second time by the coordinator.
 */
export const ABANDONED_TRIAGE_AFTER_MS = 45 * 60 * 1000
export const TRIAGE_BASE_BACKOFF_MS = 60 * 1000
export const TRIAGE_MAX_BACKOFF_MS = 60 * 60 * 1000
const RULE_QUERY_LIMIT = 50

export interface PendingMessage {
  id: string
  accountId: string
  receivedAt: Date
  triageAttempts: number
  triageStatus: 'pending' | 'failed'
  triageNextAttemptAt: Date | null
  fromEmail: string
  subject: string
  rfcMessageId: string | null
  /** True when the message arrived after the account's silent-backfill boundary. */
  live: boolean
}

export interface ClaimedMessage {
  id: string
  accountId: string
  receivedAt: Date
  triageAttempts: number
  triageStatus: 'in_progress'
  fromEmail: string
  subject: string
  rfcMessageId: string | null
}

export interface FairCandidate {
  accountId: string
  live: boolean
}

/** Exponential backoff for classification retries: 1m base, 1h cap. */
export function triageRetryDelayMs(attempts: number): number {
  return Math.min(TRIAGE_MAX_BACKOFF_MS, TRIAGE_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1))
}

function liveExpression() {
  return sql<boolean>`(${mailboxSyncState.notificationBoundaryAt} is not null and ${messages.receivedAt} > ${mailboxSyncState.notificationBoundaryAt})`
}

function eligibleWhere(now: Date) {
  return and(
    lt(messages.triageAttempts, MAX_TRIAGE_ATTEMPTS),
    or(
      eq(messages.triageStatus, 'pending'),
      and(
        eq(messages.triageStatus, 'failed'),
        or(isNull(messages.triageNextAttemptAt), lte(messages.triageNextAttemptAt, now)),
      ),
    ),
  )
}

function candidateSelection() {
  return {
    id: messages.id,
    accountId: messages.accountId,
    receivedAt: messages.receivedAt,
    triageAttempts: messages.triageAttempts,
    triageStatus: messages.triageStatus,
    triageNextAttemptAt: messages.triageNextAttemptAt,
    fromEmail: messages.fromEmail,
    subject: messages.subject,
    rfcMessageId: messages.rfcMessageId,
    live: liveExpression(),
  }
}

type CandidateRow = Omit<PendingMessage, 'triageStatus'> & {
  triageStatus: 'pending' | 'failed' | 'in_progress' | 'classified' | 'skipped'
}

function roundRobin<T extends FairCandidate>(rows: readonly T[], limit: number): T[] {
  if (limit <= 0) return []
  const byAccount = new Map<string, T[]>()
  for (const row of rows) {
    const queue = byAccount.get(row.accountId)
    if (queue) queue.push(row)
    else byAccount.set(row.accountId, [row])
  }

  const accounts = [...byAccount.keys()].sort()
  const selected: T[] = []
  while (selected.length < limit) {
    let added = false
    for (const account of accounts) {
      const row = byAccount.get(account)?.shift()
      if (!row) continue
      selected.push(row)
      added = true
      if (selected.length >= limit) break
    }
    if (!added) break
  }
  return selected
}

/**
 * Live arrivals first, then silent backfill, with accounts interleaved so a single large inbox
 * cannot consume a whole classification batch.
 */
export function selectFairCandidates<T extends FairCandidate>(
  rows: readonly T[],
  limit: number,
): T[] {
  const live = roundRobin(
    rows.filter((row) => row.live),
    limit,
  )
  if (live.length >= limit) return live
  return [
    ...live,
    ...roundRobin(
      rows.filter((row) => !row.live),
      limit - live.length,
    ),
  ]
}

async function selectCandidates(
  db: Db,
  options: { limit: number; now: Date },
): Promise<CandidateRow[]> {
  const accountRows = await db
    .selectDistinct({ accountId: messages.accountId })
    .from(messages)
    .where(eligibleWhere(options.now))
  if (accountRows.length === 0) return []

  const rows: CandidateRow[] = []
  for (const { accountId } of accountRows) {
    const accountRowsForClaim = await db
      .select(candidateSelection())
      .from(messages)
      .leftJoin(mailboxSyncState, eq(mailboxSyncState.accountId, messages.accountId))
      .where(and(eligibleWhere(options.now), eq(messages.accountId, accountId)))
      .orderBy(sql`${liveExpression()} desc`, desc(messages.receivedAt))
      .limit(options.limit)
    rows.push(...(accountRowsForClaim as CandidateRow[]))
  }

  return rows.sort(
    (a, b) => Number(b.live) - Number(a.live) || b.receivedAt.getTime() - a.receivedAt.getTime(),
  )
}

/**
 * Candidate rows for the rule pass and classifier. This scan is independent of ingestion
 * enqueue success: any eligible pending/failed row can be picked up after a crash.
 */
function toPendingMessage(row: CandidateRow): PendingMessage {
  return {
    ...row,
    triageStatus: row.triageStatus === 'failed' ? 'failed' : 'pending',
  }
}

export async function listPendingMessages(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<PendingMessage[]> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 50))
  const now = options.now ?? new Date()
  const rows = selectFairCandidates(await selectCandidates(db, { limit, now }), limit)

  return rows.map(toPendingMessage)
}

/**
 * Pending messages that match at least one active rule. This query is independent of the
 * model budget and of the fair classification batch, so deterministic rules cannot be starved
 * by a large non-matching backlog.
 */
export async function listRuleMatchedMessages(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<PendingMessage[]> {
  const limit = Math.min(200, Math.max(1, options.limit ?? RULE_QUERY_LIMIT))
  const now = options.now ?? new Date()
  const senderMatch = and(
    eq(mailRules.matchType, 'sender'),
    eq(mailRules.matchValue, sql`lower(${messages.fromEmail})`),
  )
  const domainMatch = and(
    eq(mailRules.matchType, 'domain'),
    eq(mailRules.matchValue, sql`split_part(lower(${messages.fromEmail}), '@', 2)`),
  )
  const subjectMatch = or(
    isNull(mailRules.subjectContains),
    sql`strpos(lower(${messages.subject}), lower(btrim(${mailRules.subjectContains}))) > 0`,
  )

  const rows = await db
    .selectDistinct(candidateSelection())
    .from(messages)
    .leftJoin(mailboxSyncState, eq(mailboxSyncState.accountId, messages.accountId))
    .innerJoin(
      mailRules,
      and(
        eq(mailRules.active, true),
        or(isNull(mailRules.accountId), eq(mailRules.accountId, messages.accountId)),
        or(senderMatch, domainMatch),
        subjectMatch,
      ),
    )
    .where(eligibleWhere(now))
    .orderBy(sql`${liveExpression()} desc`, desc(messages.receivedAt))
    .limit(limit)

  const seen = new Set<string>()
  const matched: PendingMessage[] = []
  for (const row of rows as CandidateRow[]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    matched.push(toPendingMessage(row))
  }
  return matched
}

async function claimSelectedIds(
  db: Db,
  ids: readonly string[],
  now: Date,
): Promise<ClaimedMessage[]> {
  if (ids.length === 0) return []

  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.id, [...ids]))
      .for('update', { skipLocked: true })
    const lockedIds = new Set(locked.map((row) => row.id))

    const claimed: ClaimedMessage[] = []
    for (const id of ids) {
      if (!lockedIds.has(id)) continue
      const [row] = await tx
        .update(messages)
        .set({
          triageStatus: 'in_progress',
          triageAttempts: sql`${messages.triageAttempts} + 1`,
          triageNextAttemptAt: null,
          triageLastError: null,
          updatedAt: now,
        })
        .where(and(eq(messages.id, id), eligibleWhere(now)))
        .returning({
          id: messages.id,
          accountId: messages.accountId,
          receivedAt: messages.receivedAt,
          triageAttempts: messages.triageAttempts,
          fromEmail: messages.fromEmail,
          subject: messages.subject,
          rfcMessageId: messages.rfcMessageId,
        })

      if (row) {
        claimed.push({ ...row, triageStatus: 'in_progress' })
      }
    }
    return claimed
  })
}

/**
 * Atomically claim classification work. Selection is fair across accounts and prefers live
 * arrivals; conditional updates make a concurrent claimer harmless.
 */
export async function claimPendingMessages(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<ClaimedMessage[]> {
  const now = options.now ?? new Date()
  const limit = Math.min(100, Math.max(1, options.limit ?? 10))
  const candidates = selectFairCandidates(await selectCandidates(db, { limit, now }), limit)
  return claimSelectedIds(
    db,
    candidates.map((row) => row.id),
    now,
  )
}

/** Claim exact message ids, used by the deterministic rule pass after it matches rules. */
export async function claimMessagesByIds(
  db: Db,
  ids: readonly string[],
  now: Date = new Date(),
): Promise<ClaimedMessage[]> {
  return claimSelectedIds(db, ids, now)
}

/**
 * Return abandoned `in_progress` rows to `pending` after a crash or lost worker. The attempt
 * stays consumed; repeated crashes eventually require the explicit retry-failed command.
 */
export async function recoverAbandonedTriage(
  db: Db,
  options: { now?: Date; staleAfterMs?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date()
  const staleBefore = new Date(now.getTime() - (options.staleAfterMs ?? ABANDONED_TRIAGE_AFTER_MS))
  const rows = await db
    .update(messages)
    .set({
      triageStatus: 'pending',
      triageNextAttemptAt: null,
      triageLastError: 'abandoned in-progress classification recovered by sweep',
      updatedAt: now,
    })
    .where(and(eq(messages.triageStatus, 'in_progress'), lt(messages.updatedAt, staleBefore)))
    .returning({ id: messages.id })
  return rows.length
}

export async function countPendingMessages(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(inArray(messages.triageStatus, ['pending', 'in_progress', 'failed']))
  return row?.count ?? 0
}

/** Rows that can actually run now (pending or a failed row whose backoff has elapsed). */
export async function countRunnableMessages(db: Db, options: { now?: Date } = {}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eligibleWhere(options.now ?? new Date()))
  return row?.count ?? 0
}

export async function countTriageFailures(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.triageStatus, 'failed'))
  return row?.count ?? 0
}

export async function countExhaustedTriage(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.triageStatus, 'failed'),
        sql`${messages.triageAttempts} >= ${MAX_TRIAGE_ATTEMPTS}`,
      ),
    )
  return row?.count ?? 0
}

export interface TriageFailureOptions {
  id: string
  attempts: number
  error: unknown
  now?: Date
}

/**
 * A transient failure (rate limit, network, provider 5xx, ambiguous outcome) schedules the
 * next attempt. Exhausted attempts become terminal and visible; manual requeue is explicit.
 */
export async function markTriageTransientFailure(
  db: Db,
  options: TriageFailureOptions,
): Promise<void> {
  const now = options.now ?? new Date()
  const exhausted = options.attempts >= MAX_TRIAGE_ATTEMPTS
  await db
    .update(messages)
    .set({
      triageStatus: 'failed',
      triageNextAttemptAt: exhausted
        ? null
        : new Date(now.getTime() + triageRetryDelayMs(options.attempts)),
      triageLastError: errorMessage(options.error),
      updatedAt: now,
    })
    .where(and(eq(messages.id, options.id), eq(messages.triageStatus, 'in_progress')))
}

/** A refusal, invalid output, or config error is terminal for this message. */
export async function markTriagePermanentFailure(
  db: Db,
  options: Omit<TriageFailureOptions, 'attempts'>,
): Promise<void> {
  const now = options.now ?? new Date()
  await db
    .update(messages)
    .set({
      triageStatus: 'failed',
      triageAttempts: sql`greatest(${messages.triageAttempts}, ${MAX_TRIAGE_ATTEMPTS})`,
      triageNextAttemptAt: null,
      triageLastError: errorMessage(options.error),
      updatedAt: now,
    })
    .where(and(eq(messages.id, options.id), eq(messages.triageStatus, 'in_progress')))
}

/** Release claims that were never sent to the model (budget pause or shutdown). */
export async function releaseClaimedMessages(
  db: Db,
  ids: readonly string[],
  now: Date = new Date(),
): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db
    .update(messages)
    .set({
      triageStatus: 'pending',
      triageAttempts: sql`greatest(0, ${messages.triageAttempts} - 1)`,
      triageNextAttemptAt: null,
      triageLastError: null,
      updatedAt: now,
    })
    .where(and(inArray(messages.id, [...ids]), eq(messages.triageStatus, 'in_progress')))
    .returning({ id: messages.id })
  return rows.length
}

/**
 * Explicit operator recovery: put failed messages back in the pending queue. A pending row that
 * reached the attempt ceiling after repeated crashes is also recoverable so it cannot get stuck
 * silently outside the runnable set.
 */
export async function requeueFailedTriage(
  db: Db,
  options: { ids?: readonly string[]; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date()
  const recoverable = or(
    eq(messages.triageStatus, 'failed'),
    and(eq(messages.triageStatus, 'pending'), gte(messages.triageAttempts, MAX_TRIAGE_ATTEMPTS)),
  )
  const condition =
    options.ids === undefined
      ? recoverable
      : and(recoverable, inArray(messages.id, [...options.ids]))

  const rows = await db
    .update(messages)
    .set({
      triageStatus: 'pending',
      triageAttempts: 0,
      triageNextAttemptAt: null,
      triageLastError: null,
      updatedAt: now,
    })
    .where(condition)
    .returning({ id: messages.id })
  return rows.length
}

export interface TriageSweepResult {
  recovered: number
  pending: number
}

/** Recovery/count pass used by the sync coordinator. */
export async function sweepTriageState(
  db: Db,
  options: { now?: Date } = {},
): Promise<TriageSweepResult> {
  const recovered = await recoverAbandonedTriage(db, options)
  return { recovered, pending: await countPendingMessages(db) }
}
