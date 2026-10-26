import { and, eq, lt, sql } from 'drizzle-orm'
import { type Db, db as defaultDb } from '../db/index.js'
import { llmCalls, type reasoningEffort, type riskTier, toolCalls } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import { type Logger, logger } from '../logger.js'

export type RiskTier = (typeof riskTier.enumValues)[number]
export type ReasoningEffort = (typeof reasoningEffort.enumValues)[number]
export type LlmCallRow = typeof llmCalls.$inferSelect
export type LlmTerminalStatus = 'succeeded' | 'failed' | 'unknown'

/** Upper bound for audit error text, matching the runs helper. */
const CALL_ERROR_LIMIT = 1000

/** In-flight reservations older than this are treated as unknown outcomes on recovery. */
export const STALE_LLM_CALL_AFTER_MS = 10 * 60 * 1000

export const STALE_LLM_CALL_ERROR = 'stale in-flight model call: outcome unknown'

/**
 * Tool calls remain foundation-only until the agent loop (phase 05). The LLM reservation
 * helpers above are ready for the classifier (phase 03 increment 4).
 */
export class ToolCallError extends Error {
  readonly reason: 'approval_required'

  constructor(message: string) {
    super(message)
    this.name = 'ToolCallError'
    this.reason = 'approval_required'
  }
}

/**
 * Throw from a tool-call handler when the side effect (a submit click) may have happened but
 * its outcome cannot be determined. The audit row becomes `unknown`, is never retried, and
 * the enclosing task is reported as `outcome_unknown`.
 */
export class ToolCallOutcomeUnknownError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'ToolCallOutcomeUnknownError'
  }
}

export interface LlmCallUsage {
  /** Total input tokens, including cached and cache-write tokens. */
  promptTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  /** Total output tokens, including reasoning tokens. */
  completionTokens?: number
  /** Diagnostic breakdown only; already included in completionTokens. */
  reasoningTokens?: number
  /** Snapshot of the computed cost for this call, in USD. */
  costUsd?: number
  providerRequestId?: string
}

/**
 * Throw from a model-call handler when the provider returned a known failure but usage (and
 * possibly a request id) is still available. The audit row becomes `failed` and records the
 * actual usage; the reservation is released because the call's cost is now known.
 */
export class LlmCallFailedError extends Error {
  readonly usage?: LlmCallUsage

  constructor(message: string, options: { cause?: unknown; usage?: LlmCallUsage } = {}) {
    super(message, { cause: options.cause })
    this.name = 'LlmCallFailedError'
    this.usage = options.usage
  }
}

/**
 * Throw from a model-call handler when the request may have reached the provider but its
 * outcome is unknown (timeout after send, reset, ambiguous provider failure). The audit row
 * becomes `unknown`, and its reserved cost stays counted conservatively.
 */
export class LlmCallOutcomeUnknownError extends Error {
  readonly usage?: LlmCallUsage

  constructor(message: string, options: { cause?: unknown; usage?: LlmCallUsage } = {}) {
    super(message, { cause: options.cause })
    this.name = 'LlmCallOutcomeUnknownError'
    this.usage = options.usage
  }
}

export interface LlmCallOutcome<T> {
  result: T
  usage?: LlmCallUsage
}

export interface WithLlmCallOptions {
  runId: string
  /** Open catalog: classify_email, draft_reply, digest_score, agent_chat, ... */
  purpose: string
  model: string
  /** Actual reasoning effort requested; null for non-reasoning calls. */
  reasoningEffort?: ReasoningEffort
  /**
   * Positive bounded worst-case cost reserved durably before the external attempt. The
   * reservation is counted until actual cost is recorded and forever for unknown outcomes.
   * A missing/non-positive reservation refuses the call before the provider is contacted.
   */
  reservedCostUsd: number
  /** Defaults to the module DB singleton. */
  db?: Db
  log?: Logger
}

async function reserveLlmCall(db: Db, options: WithLlmCallOptions): Promise<LlmCallRow> {
  if (!Number.isFinite(options.reservedCostUsd) || options.reservedCostUsd <= 0) {
    throw new Error('withLlmCall requires a positive reservedCostUsd before the model call')
  }

  const [row] = await db
    .insert(llmCalls)
    .values({
      runId: options.runId,
      purpose: options.purpose,
      model: options.model,
      status: 'in_flight',
      reservedCostUsd: options.reservedCostUsd.toFixed(6),
      ...(options.reasoningEffort !== undefined
        ? { reasoningEffort: options.reasoningEffort }
        : {}),
    })
    .returning()

  if (!row) {
    throw new Error('withLlmCall did not return the in-flight model call row')
  }
  return row
}

async function finalizeLlmCall(
  db: Db,
  id: string,
  outcome: {
    status: LlmTerminalStatus
    latencyMs: number
    usage?: LlmCallUsage
    error?: unknown
  },
): Promise<void> {
  const usage = outcome.usage ?? {}
  await db
    .update(llmCalls)
    .set({
      status: outcome.status,
      promptTokens: Math.max(0, usage.promptTokens ?? 0),
      cachedInputTokens: Math.max(0, usage.cachedInputTokens ?? 0),
      cacheWriteTokens: Math.max(0, usage.cacheWriteTokens ?? 0),
      completionTokens: Math.max(0, usage.completionTokens ?? 0),
      reasoningTokens: Math.max(0, usage.reasoningTokens ?? 0),
      costUsd: Math.max(0, usage.costUsd ?? 0).toFixed(6),
      latencyMs: Math.max(0, outcome.latencyMs),
      ...(usage.providerRequestId !== undefined
        ? { providerRequestId: usage.providerRequestId }
        : {}),
      ...(outcome.error !== undefined
        ? { error: errorMessage(outcome.error, CALL_ERROR_LIMIT) }
        : {}),
    })
    .where(eq(llmCalls.id, id))
}

/**
 * Audit wrapper for one model call attempt with durable budget reservation:
 * insert `in_flight` + reserved worst-case cost → call handler → finalize to
 * `succeeded`/`failed` (`unknown` when the handler throws LlmCallOutcomeUnknownError).
 *
 * If the reservation insert fails, the model call is not attempted: spending without a
 * durable reservation would bypass the daily budget. If finalization fails, the original
 * result/error wins and the row stays `in_flight`; stale recovery marks it `unknown` and
 * keeps its reserved cost counted.
 */
export async function withLlmCall<T>(
  options: WithLlmCallOptions,
  handler: () => Promise<LlmCallOutcome<T>>,
): Promise<T> {
  const db = options.db ?? defaultDb
  const log = options.log ?? logger
  const startedAt = Date.now()

  const row = await reserveLlmCall(db, options)

  try {
    const { result, usage } = await handler()
    try {
      await finalizeLlmCall(db, row.id, {
        status: 'succeeded',
        latencyMs: Date.now() - startedAt,
        ...(usage !== undefined ? { usage } : {}),
      })
    } catch (auditError) {
      log.error({ err: errorMessage(auditError) }, 'failed to finalize llm call success')
    }
    return result
  } catch (error) {
    const unknown = error instanceof LlmCallOutcomeUnknownError
    const failedWithUsage = error instanceof LlmCallFailedError
    try {
      await finalizeLlmCall(db, row.id, {
        status: unknown ? 'unknown' : 'failed',
        latencyMs: Date.now() - startedAt,
        ...((unknown || failedWithUsage) && error.usage !== undefined
          ? { usage: error.usage }
          : {}),
        error,
      })
    } catch (auditError) {
      log.error({ err: errorMessage(auditError) }, 'failed to finalize llm call failure')
    }
    throw error
  }
}

/**
 * Mark one in-flight model call unknown, keeping its reserved cost. Used by recovery and by
 * callers that reconcile an abandoned attempt.
 */
export async function markLlmCallUnknown(
  db: Db,
  id: string,
  options: { error?: unknown; usage?: LlmCallUsage } = {},
): Promise<void> {
  await finalizeLlmCall(db, id, {
    status: 'unknown',
    latencyMs: 0,
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
    ...(options.error !== undefined ? { error: options.error } : { error: STALE_LLM_CALL_ERROR }),
  })
}

/**
 * Recover rows left `in_flight` by a crash. Their provider outcome is unknown, so they
 * become `unknown` and the budget query keeps counting their reserved cost.
 */
export async function recoverStaleInFlightLlmCalls(
  db: Db,
  options: { now?: Date; olderThanMs?: number; error?: unknown } = {},
): Promise<number> {
  const now = options.now ?? new Date()
  const staleBefore = new Date(now.getTime() - (options.olderThanMs ?? STALE_LLM_CALL_AFTER_MS))
  const rows = await db
    .update(llmCalls)
    .set({
      status: 'unknown',
      error: errorMessage(options.error ?? STALE_LLM_CALL_ERROR, CALL_ERROR_LIMIT),
    })
    .where(and(eq(llmCalls.status, 'in_flight'), lt(llmCalls.createdAt, staleBefore)))
    .returning({ id: llmCalls.id })
  return rows.length
}

/**
 * Mark one in-flight tool call `unknown`, keeping its row: used by startup recovery for a
 * send whose click may have happened before the worker died.
 */
export async function markToolCallUnknown(
  db: Db,
  id: string,
  options: { error?: unknown } = {},
): Promise<void> {
  await db
    .update(toolCalls)
    .set({
      status: 'unknown',
      // Never before started_at, even under app/DB clock skew.
      finishedAt: sql`greatest(clock_timestamp(), ${toolCalls.startedAt})`,
      error: errorMessage(
        options.error ?? new Error('interrupted: tool-call outcome unknown'),
        CALL_ERROR_LIMIT,
      ),
    })
    .where(eq(toolCalls.id, id))
}

export interface WithToolCallOptions {
  runId: string
  toolName: string
  riskTier: RiskTier
  /**
   * Ids/references only; for approved calls these are copied from `approvals.payload` and
   * never re-read from the model. No secrets.
   */
  args?: Record<string, unknown>
  /** Required for `send` tier (D008); the row insert claims the approval via a unique index. */
  approvalId?: string
  /** Defaults to the module DB singleton. */
  db?: Db
  log?: Logger
}

export interface WithToolCallAuditOptions<T> extends WithToolCallOptions {
  /**
   * Maps the handler's result to what is stored in `tool_calls.result`. Use it when the result
   * carries untrusted or large content (page snapshots) that must not be persisted.
   */
  auditResult?: (result: T) => unknown
}

/**
 * Audit wrapper for one tool invocation: inserts a `running` row first (the at-most-once
 * claim for approved executions), runs the handler with the row id, then finalizes to
 * `succeeded`/`failed` with bounded error text. The handler's error is always rethrown.
 *
 * `send` tier without an `approvalId` is rejected before any row exists. The browser tool layer
 * (phase 05) is the first consumer; it passes `auditResult` so page content is never stored.
 */
export async function withToolCall<T>(
  options: WithToolCallAuditOptions<T>,
  handler: (toolCallId: string) => Promise<T>,
): Promise<T> {
  const db = options.db ?? defaultDb
  const log = options.log ?? logger

  if (options.riskTier === 'send' && options.approvalId === undefined) {
    throw new ToolCallError(
      `tool "${options.toolName}" is risk tier "send" and requires an approval id`,
    )
  }

  const [row] = await db
    .insert(toolCalls)
    .values({
      runId: options.runId,
      toolName: options.toolName,
      riskTier: options.riskTier,
      status: 'running',
      args: options.args ?? {},
      ...(options.approvalId !== undefined ? { approvalId: options.approvalId } : {}),
    })
    .returning()

  if (!row) {
    throw new Error('withToolCall did not return the running tool call row')
  }

  const startedAt = Date.now()
  const finalize = (
    status: 'succeeded' | 'failed' | 'unknown',
    patch: { result?: unknown; error?: unknown },
  ) =>
    db
      .update(toolCalls)
      .set({
        status,
        // DB clock, never before started_at (also DB clock): a fast call must not trip the
        // finished-after-started check through app/DB clock skew.
        finishedAt: sql`greatest(clock_timestamp(), ${toolCalls.startedAt})`,
        latencyMs: Math.max(0, Date.now() - startedAt),
        ...(patch.result !== undefined ? { result: patch.result } : {}),
        ...(patch.error !== undefined
          ? { error: errorMessage(patch.error, CALL_ERROR_LIMIT) }
          : {}),
      })
      .where(eq(toolCalls.id, row.id))

  try {
    const result = await handler(row.id)
    try {
      const audited = options.auditResult !== undefined ? options.auditResult(result) : result
      await finalize('succeeded', { result: audited === undefined ? null : audited })
    } catch (auditError) {
      log.error({ err: errorMessage(auditError) }, 'failed to record tool call success')
    }
    return result
  } catch (error) {
    const unknown = error instanceof ToolCallOutcomeUnknownError
    try {
      await finalize(unknown ? 'unknown' : 'failed', { error })
    } catch (auditError) {
      log.error({ err: errorMessage(auditError) }, 'failed to record tool call failure')
    }
    throw error
  }
}
