import type { gmail_v1 } from '@googleapis/gmail'
import { eq } from 'drizzle-orm'
import type { Db, DbSession } from '../db/index.js'
import { accounts, mailboxSyncState } from '../db/schema/index.js'
import { type Logger, logger } from '../logger.js'
import { loadStoredMessageLabels, updateMessageLabels, upsertParsedMessages } from './ingestion.js'
import { isExcludedMessage, type ParsedGmailMessage, parseGmailMessage } from './mime.js'
import {
  ensureSyncState,
  markSyncFailure,
  markSyncPolled,
  markSyncSuccess,
  type SyncStateRow,
  setNeedsFullResync,
} from './sync-state.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Initial silent backfill window and per-page API size. */
export const BACKFILL_DAYS = 7
export const GMAIL_PAGE_SIZE = 100
/** Recovery looks back before the last success so a missed edge cannot be skipped. */
export const RECOVERY_OVERLAP_MS = 60 * 60 * 1000
export const GMAIL_QUERY = '-in:spam -in:trash -in:drafts -in:sent'

/** Narrow Gmail surface used by sync; tests inject a fake with the same shape. */
export interface GmailSyncApi {
  users: {
    getProfile(params: { userId: string }): Promise<{ data: { historyId?: string | null } }>
    messages: {
      list(params: {
        userId: string
        q?: string
        maxResults?: number
        pageToken?: string
      }): Promise<{
        data: {
          messages?: Array<{ id?: string | null }> | null
          nextPageToken?: string | null
        }
      }>
      get(params: {
        userId: string
        id: string
        format?: string
      }): Promise<{ data: gmail_v1.Schema$Message }>
    }
    history: {
      list(params: {
        userId: string
        startHistoryId?: string
        maxResults?: number
        pageToken?: string
      }): Promise<{ data: gmail_v1.Schema$ListHistoryResponse }>
    }
  }
}

export type SyncMode = 'initial' | 'incremental' | 'recovery'
export type SyncSkipReason = 'inactive' | 'backoff'

export interface SyncCounters {
  fetched: number
  ingested: number
  skipped: number
  labelChanges: number
  historyPages: number
}

export interface SyncAccountResult {
  skipped: boolean
  reason?: SyncSkipReason
  mode: SyncMode | 'skipped'
  accountId: string
  historyId: string | null
  counters: SyncCounters
}

export interface SyncAccountOptions {
  db: Db
  accountId: string
  api: GmailSyncApi
  now?: Date
  /** Delay before each Gmail API call; keeps backfill under per-minute project quotas. */
  requestDelayMs?: number
  log?: Logger
}

interface SyncContext {
  db: Db
  accountId: string
  api: GmailSyncApi
  now: Date
  requestDelayMs: number
  counters: SyncCounters
}

interface LabelOperation {
  providerMessageId: string
  add: string[]
  remove: string[]
}

function emptyCounters(): SyncCounters {
  return { fetched: 0, ingested: 0, skipped: 0, labelChanges: 0, historyPages: 0 }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Pace outbound Gmail calls; zero keeps unit tests fast. */
async function pace(context: SyncContext): Promise<void> {
  if (context.requestDelayMs > 0) {
    await wait(context.requestDelayMs)
  }
}

export function maxHistoryId(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  try {
    return BigInt(a) >= BigInt(b) ? a : b
  } catch {
    return a
  }
}

function errorStatus(error: unknown, depth = 0): number | undefined {
  if (error == null || typeof error !== 'object' || depth > 5) return undefined
  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    code?: unknown
    response?: { status?: unknown; statusCode?: unknown }
    cause?: unknown
  }
  const status = candidate.response?.status ?? candidate.response?.statusCode
  if (typeof status === 'number') return status
  if (typeof status === 'string' && /^\d+$/.test(status)) return Number(status)
  if (typeof candidate.status === 'number') return candidate.status
  if (typeof candidate.statusCode === 'number') return candidate.statusCode
  if (candidate.code === 404) return 404
  if (typeof candidate.code === 'string' && /^\d+$/.test(candidate.code)) {
    return Number(candidate.code)
  }
  if (candidate.cause !== undefined) return errorStatus(candidate.cause, depth + 1)
  return undefined
}

export function isNotFoundError(error: unknown): boolean {
  return errorStatus(error) === 404
}

/** Gmail history IDs older than the provider's window produce 404; recover by scan. */
export function isHistoryExpiredError(error: unknown): boolean {
  return errorStatus(error) === 404
}

function messageQuery(after: Date): string {
  return `after:${Math.floor(after.getTime() / 1000)} ${GMAIL_QUERY}`
}

async function getCheckpoint(context: SyncContext): Promise<string> {
  await pace(context)
  const { data } = await context.api.users.getProfile({ userId: 'me' })
  const historyId = data.historyId?.trim()
  if (!historyId) throw new Error('Gmail profile did not return a historyId')
  return historyId
}

async function fetchParsedMessages(
  context: SyncContext,
  ids: readonly string[],
): Promise<ParsedGmailMessage[]> {
  const parsed: ParsedGmailMessage[] = []
  const uniqueIds = [...new Set(ids)]

  for (const id of uniqueIds) {
    try {
      await pace(context)
      const { data } = await context.api.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      })
      context.counters.fetched += 1
      let message: ParsedGmailMessage | null
      try {
        message = parseGmailMessage(data, context.now)
      } catch {
        context.counters.skipped += 1
        continue
      }
      if (!message || isExcludedMessage(message.providerLabels)) {
        context.counters.skipped += 1
        continue
      }
      parsed.push(message)
    } catch (error) {
      if (isNotFoundError(error)) {
        // Removed between history/list and get: skip without blocking the mailbox.
        context.counters.skipped += 1
        continue
      }
      throw error
    }
  }

  return parsed
}

async function ingestMessageList(context: SyncContext, after: Date): Promise<void> {
  let pageToken: string | undefined
  const q = messageQuery(after)

  do {
    await pace(context)
    const { data } = await context.api.users.messages.list({
      userId: 'me',
      q,
      maxResults: GMAIL_PAGE_SIZE,
      pageToken,
    })
    const ids = (data.messages ?? [])
      .map((message) => message.id)
      .filter((id): id is string => Boolean(id))
    const parsed = await fetchParsedMessages(context, ids)
    const ingested = await context.db.transaction((tx) =>
      upsertParsedMessages(tx, context.accountId, parsed, context.now),
    )
    context.counters.ingested += ingested
    pageToken = data.nextPageToken ?? undefined
  } while (pageToken)
}

function addLabelOperations(
  operations: LabelOperation[],
  records: readonly gmail_v1.Schema$History[],
): void {
  for (const record of records) {
    for (const entry of record.labelsAdded ?? []) {
      const id = entry.message?.id
      if (id && entry.labelIds?.length) {
        operations.push({ providerMessageId: id, add: entry.labelIds, remove: [] })
      }
    }
    for (const entry of record.labelsRemoved ?? []) {
      const id = entry.message?.id
      if (id && entry.labelIds?.length) {
        operations.push({ providerMessageId: id, add: [], remove: entry.labelIds })
      }
    }
  }
}

async function applyLabelOperations(
  db: DbSession,
  accountId: string,
  operations: readonly LabelOperation[],
  now: Date,
): Promise<number> {
  if (operations.length === 0) return 0

  const ids = operations.map((operation) => operation.providerMessageId)
  const rows = await loadStoredMessageLabels(db, accountId, ids)
  const labelsByProviderId = new Map(
    rows.map((row) => [row.providerMessageId, { id: row.id, labels: [...row.providerLabels] }]),
  )
  const applied = new Map<string, { id: string; labels: string[]; original: string[] }>()

  for (const operation of operations) {
    const entry = labelsByProviderId.get(operation.providerMessageId)
    if (!entry) continue

    let current = applied.get(operation.providerMessageId)
    if (!current) {
      current = { id: entry.id, labels: [...entry.labels], original: [...entry.labels] }
      applied.set(operation.providerMessageId, current)
    }
    const add = new Set(operation.add)
    const remove = new Set(operation.remove)
    current.labels = [...new Set([...current.labels.filter((label) => !remove.has(label)), ...add])]
  }

  let changes = 0
  for (const entry of applied.values()) {
    const before = [...entry.original].sort().join('\u0000')
    const after = [...entry.labels].sort().join('\u0000')
    if (before === after) continue
    await updateMessageLabels(db, entry.id, entry.labels, now)
    changes += 1
  }
  return changes
}

async function syncHistory(context: SyncContext, startHistoryId: string): Promise<string> {
  let pageToken: string | undefined
  let cursor = startHistoryId

  do {
    await pace(context)
    const { data } = await context.api.users.history.list({
      userId: 'me',
      startHistoryId,
      maxResults: GMAIL_PAGE_SIZE,
      pageToken,
    })
    context.counters.historyPages += 1

    const records = data.history ?? []
    const addedIds = records.flatMap((record) =>
      (record.messagesAdded ?? [])
        .map((entry) => entry.message?.id)
        .filter((id): id is string => Boolean(id)),
    )
    const parsed = await fetchParsedMessages(context, addedIds)
    const operations: LabelOperation[] = []
    addLabelOperations(operations, records)

    const lastRecordId = records.at(-1)?.id ?? null
    let nextCursor = maxHistoryId(cursor, lastRecordId)
    if (!data.nextPageToken && data.historyId) {
      // Only advance to the mailbox sequence id once every page has been processed.
      nextCursor = maxHistoryId(nextCursor, data.historyId)
    }

    await context.db.transaction(async (tx) => {
      context.counters.ingested += await upsertParsedMessages(
        tx,
        context.accountId,
        parsed,
        context.now,
      )
      context.counters.labelChanges += await applyLabelOperations(
        tx,
        context.accountId,
        operations,
        context.now,
      )
      if (nextCursor) {
        await tx
          .update(mailboxSyncState)
          .set({ historyId: nextCursor, updatedAt: context.now })
          .where(eq(mailboxSyncState.accountId, context.accountId))
      }
    })

    cursor = nextCursor ?? cursor
    pageToken = data.nextPageToken ?? undefined
  } while (pageToken)

  return cursor
}

async function runInitialSync(context: SyncContext, state: SyncStateRow): Promise<string> {
  const checkpoint = await getCheckpoint(context)
  const boundary = state.notificationBoundaryAt ?? context.now
  const backfillFrom = new Date(boundary.getTime() - BACKFILL_DAYS * DAY_MS)

  await ingestMessageList(context, backfillFrom)
  await markSyncSuccess(context.db, context.accountId, context.now, {
    historyId: checkpoint,
    initialSyncCompletedAt: context.now,
    needsFullResync: false,
  })

  try {
    return await syncHistory(context, checkpoint)
  } catch (error) {
    if (!isHistoryExpiredError(error)) throw error
    await setNeedsFullResync(context.db, context.accountId, context.now)
    return runRecovery(context, state)
  }
}

async function runRecovery(context: SyncContext, state: SyncStateRow): Promise<string> {
  const checkpoint = await getCheckpoint(context)
  const base = state.lastSuccessAt ?? state.notificationBoundaryAt ?? context.now
  const overlap = state.lastSuccessAt ? RECOVERY_OVERLAP_MS : BACKFILL_DAYS * DAY_MS
  const scanFrom = new Date(base.getTime() - overlap)

  await ingestMessageList(context, scanFrom)
  await markSyncSuccess(context.db, context.accountId, context.now, {
    historyId: checkpoint,
    initialSyncCompletedAt: state.initialSyncCompletedAt ?? context.now,
    needsFullResync: false,
  })

  try {
    return await syncHistory(context, checkpoint)
  } catch (error) {
    if (isHistoryExpiredError(error)) {
      await setNeedsFullResync(context.db, context.accountId, context.now)
    }
    throw error
  }
}

/**
 * One account sync pass. Initial sync captures the profile history checkpoint before the
 * seven-day backfill, then replays history from that checkpoint so setup-time arrivals are not
 * missed. Incremental pages commit messages/labels and the history cursor together. Expired
 * cursors fall back to a scan since the last success with overlap (never a fixed seven-day cap).
 */
export async function syncAccount(options: SyncAccountOptions): Promise<SyncAccountResult> {
  const now = options.now ?? new Date()
  const log = options.log ?? logger
  const counters = emptyCounters()

  const [account] = await options.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, options.accountId))
    .limit(1)
  if (!account) {
    throw new Error(`sync account ${options.accountId} was not found`)
  }
  if (account.status !== 'active') {
    return {
      skipped: true,
      reason: 'inactive',
      mode: 'skipped',
      accountId: account.id,
      historyId: null,
      counters,
    }
  }

  const state = await ensureSyncState(options.db, account, now)
  if (state.backoffUntil && state.backoffUntil.getTime() > now.getTime()) {
    return {
      skipped: true,
      reason: 'backoff',
      mode: 'skipped',
      accountId: account.id,
      historyId: state.historyId,
      counters,
    }
  }

  await markSyncPolled(options.db, account.id, now)
  const context: SyncContext = {
    db: options.db,
    accountId: account.id,
    api: options.api,
    now,
    requestDelayMs: Math.max(0, options.requestDelayMs ?? 0),
    counters,
  }

  try {
    let mode: SyncMode
    let historyId: string
    if (!state.initialSyncCompletedAt || !state.historyId) {
      mode = 'initial'
      historyId = await runInitialSync(context, state)
    } else if (state.needsFullResync) {
      mode = 'recovery'
      historyId = await runRecovery(context, state)
    } else {
      mode = 'incremental'
      try {
        historyId = await syncHistory(context, state.historyId)
      } catch (error) {
        if (!isHistoryExpiredError(error)) throw error
        await setNeedsFullResync(options.db, account.id, now)
        mode = 'recovery'
        historyId = await runRecovery(context, state)
      }
    }

    await markSyncSuccess(options.db, account.id, now)
    log.info(
      {
        accountId: account.id,
        mode,
        historyId,
        counters,
      },
      'mail sync complete',
    )
    return {
      skipped: false,
      mode,
      accountId: account.id,
      historyId,
      counters,
    }
  } catch (error) {
    const failure = await markSyncFailure(options.db, account.id, error, now)
    log.warn(
      {
        accountId: account.id,
        consecutiveFailures: failure.consecutiveFailures,
        backoffUntil: failure.backoffUntil,
        error: failure.error,
      },
      'mail sync failed',
    )
    throw error
  }
}
