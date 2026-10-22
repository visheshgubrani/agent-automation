import {
  LlmCallFailedError,
  LlmCallOutcomeUnknownError,
  type LlmCallUsage,
  withLlmCall,
} from '../audit/calls.js'
import { withRun } from '../audit/runs.js'
import type { MailConfig } from '../config.js'
import type { Db } from '../db/index.js'
import { errorMessage } from '../errors.js'
import { type Logger, logger } from '../logger.js'
import {
  enqueueMailBudgetNotice,
  getMailSpendStatus,
  hasMailBudgetNotice,
  type MailSpendStatus,
} from './budget.js'
import {
  loadTriageMessage,
  recordClassifierDecision,
  recordRuleDecision,
  type TriageMessage,
} from './classification.js'
import { ClassifierInputTooLargeError, ClassifierUncertainError } from './classifier-errors.js'
import { buildClassifierPrompt, type ClassifierOutput } from './classifier-prompt.js'
import { listBankSenders, listCompanyDomains } from './config.js'
import { loadFeedbackExamples } from './examples.js'
import {
  isPermanentModelError,
  isUncertainModelError,
  type MailClassifier,
  providerRequestIdOf,
} from './openai-classifier.js'
import { loadActiveRules, pickWinningRule } from './rules.js'
import { withSerializedModelCall } from './serial.js'
import {
  type ClaimedMessage,
  claimMessagesByIds,
  claimPendingMessages,
  countRunnableMessages,
  listRuleMatchedMessages,
  markTriagePermanentFailure,
  markTriageTransientFailure,
  releaseClaimedMessages,
} from './triage-state.js'

/** Small enough that worst-case per-call timeouts fit inside the queue expiry. */
export const TRIAGE_BATCH_SIZE = 5
export const RULE_PASS_LIMIT = 50

export interface MailTriageOptions {
  db: Db
  runId: string
  mail: MailConfig
  classifier: MailClassifier
  now?: Date
  log?: Logger
  signal?: AbortSignal
}

export interface MailTriageResult {
  rulesApplied: number
  classified: number
  failed: number
  paused: boolean
  released: number
  pending: number
}

export interface TriagePreflightOptions {
  db: Db
  mail: Pick<MailConfig, 'model' | 'maxInputChars' | 'maxOutputTokens'>
  now?: Date
  log?: Logger
}

export interface TriagePreflightResult {
  run: boolean
  pending: number
  paused: boolean
}

async function loadHintConfig(db: Db): Promise<{
  companyDomains: string[]
  bankSenders: string[]
}> {
  const [domains, senders] = await Promise.all([listCompanyDomains(db), listBankSenders(db)])
  return {
    companyDomains: domains.map((row) => row.domain),
    bankSenders: senders.map((row) => row.email),
  }
}

/**
 * Cheap gate before opening a run. Rule matches still run while the model budget is exhausted;
 * otherwise a paused day only inserts its single budget notice and skips audit noise.
 */
export async function triagePreflight(
  options: TriagePreflightOptions,
): Promise<TriagePreflightResult> {
  const now = options.now ?? new Date()
  const pending = await countRunnableMessages(options.db, { now })
  if (pending === 0) return { run: false, pending: 0, paused: false }

  const ruleMatches = await listRuleMatchedMessages(options.db, { limit: 1, now })
  if (ruleMatches.length > 0) {
    return { run: true, pending, paused: false }
  }

  const status = await getMailSpendStatus(options.db, {
    now,
    model: options.mail.model,
    maxInputChars: options.mail.maxInputChars,
    maxOutputTokens: options.mail.maxOutputTokens,
  })
  if (!status.canAdmit) {
    if (!(await hasMailBudgetNotice(options.db, status.range.dayKey))) {
      await withRun(
        {
          db: options.db,
          kind: 'system',
          trigger: 'schedule',
          input: { job: 'mail-budget-notice' },
          ...(options.log !== undefined ? { log: options.log } : {}),
        },
        async ({ run }) => {
          await enqueueMailBudgetNotice(options.db, {
            status,
            pending,
            runId: run.id,
          })
        },
      )
    }
    return { run: false, pending, paused: true }
  }

  return { run: true, pending, paused: false }
}

function maxCallsForBudget(status: MailSpendStatus, batchSize: number): number {
  const limit = status.settings.dailyLimitUsd
  if (limit === null) return batchSize
  if (status.reservationUsd <= 0) return batchSize
  const remaining = Math.max(0, limit - status.usage.totalUsd)
  return Math.min(batchSize, Math.floor((remaining + 1e-9) / status.reservationUsd))
}

function failureKind(error: unknown): 'permanent' | 'transient' {
  if (error instanceof LlmCallOutcomeUnknownError) return 'transient'

  const cause = error instanceof LlmCallFailedError ? error.cause : error
  if (isPermanentModelError(cause) || isPermanentModelError(error)) return 'permanent'
  if (cause instanceof ClassifierUncertainError) return 'transient'
  return 'transient'
}

/**
 * Wrap provider errors so `withLlmCall` can record request ids and known usage. Ambiguous
 * outcomes become `unknown` and keep their budget reservation; definitive 4xx/refusals become
 * `failed` with whatever usage is available.
 */
function modelCallError(error: unknown): unknown {
  const detail = error instanceof Error && error.message ? `: ${error.message}` : ''
  if (error instanceof ClassifierUncertainError) {
    return new LlmCallOutcomeUnknownError(`classifier outcome is unknown${detail}`, {
      cause: error,
      ...(error.usage !== undefined ? { usage: error.usage } : {}),
    })
  }

  if (error instanceof Error && 'usage' in error) {
    const usage = (error as { usage?: LlmCallUsage }).usage
    const requestId = providerRequestIdOf(error)
    return new LlmCallFailedError(error.message, {
      cause: error,
      ...(usage !== undefined
        ? { usage }
        : requestId !== undefined
          ? { usage: { providerRequestId: requestId } }
          : {}),
    })
  }

  const requestId = providerRequestIdOf(error)
  if (isUncertainModelError(error)) {
    return new LlmCallOutcomeUnknownError(`classifier outcome is unknown${detail}`, {
      cause: error,
      ...(requestId !== undefined ? { usage: { providerRequestId: requestId } } : {}),
    })
  }
  if (requestId !== undefined) {
    return new LlmCallFailedError('classifier call failed', {
      cause: error,
      usage: { providerRequestId: requestId },
    })
  }
  return error
}

async function applyRule(
  db: Db,
  runId: string,
  message: TriageMessage | ClaimedMessage,
  rule: ReturnType<typeof pickWinningRule>,
  now: Date,
): Promise<boolean> {
  if (!rule) return false
  await recordRuleDecision(db, { messageId: message.id, runId, rule, now })
  return true
}

/**
 * One triage pass: deterministic rules first, then a fair classifier batch within the local-day
 * budget. Every paid attempt is reserved/audited by `withLlmCall`; failures are never recorded
 * as ignore decisions.
 */
export async function runMailTriage(options: MailTriageOptions): Promise<MailTriageResult> {
  const db = options.db
  const log = options.log ?? logger
  const now = options.now ?? new Date()
  const result: MailTriageResult = {
    rulesApplied: 0,
    classified: 0,
    failed: 0,
    paused: false,
    released: 0,
    pending: 0,
  }

  const rules = await loadActiveRules(db)
  const hints = await loadHintConfig(db)

  const matched = await listRuleMatchedMessages(db, { limit: RULE_PASS_LIMIT, now })
  const ruleClaims =
    matched.length === 0
      ? []
      : await claimMessagesByIds(
          db,
          matched.map((candidate) => candidate.id),
          now,
        )

  for (const message of ruleClaims) {
    const rule = pickWinningRule(rules, message)
    if (await applyRule(db, options.runId, message, rule, now)) {
      result.rulesApplied += 1
    } else {
      result.released += await releaseClaimedMessages(db, [message.id], now)
    }
  }

  const initialStatus = await getMailSpendStatus(db, {
    now,
    model: options.mail.model,
    maxInputChars: options.mail.maxInputChars,
    maxOutputTokens: options.mail.maxOutputTokens,
  })
  const maxCalls = maxCallsForBudget(initialStatus, TRIAGE_BATCH_SIZE)
  if (maxCalls <= 0) {
    result.pending = await countRunnableMessages(db, { now })
    if (result.pending > 0) {
      await enqueueMailBudgetNotice(db, {
        status: initialStatus,
        pending: result.pending,
        runId: options.runId,
      })
      result.paused = true
    }
    return result
  }

  const claimed = await claimPendingMessages(db, { limit: maxCalls, now })
  let processed = 0

  try {
    for (const [index, claim] of claimed.entries()) {
      processed = index
      const message = await loadTriageMessage(db, claim.id)
      if (!message) continue

      const rule = pickWinningRule(rules, message)
      if (await applyRule(db, options.runId, message, rule, now)) {
        result.rulesApplied += 1
        continue
      }

      const examples = await loadFeedbackExamples(db, {
        id: message.id,
        rfcMessageId: message.rfcMessageId,
        fromEmail: message.fromEmail,
      })
      let prompt: ReturnType<typeof buildClassifierPrompt>
      try {
        prompt = buildClassifierPrompt({
          message,
          examples,
          companyDomains: hints.companyDomains,
          bankSenders: hints.bankSenders,
          maxInputChars: options.mail.maxInputChars,
        })
      } catch (error) {
        if (!(error instanceof ClassifierInputTooLargeError)) throw error
        await markTriagePermanentFailure(db, { id: message.id, error, now })
        result.failed += 1
        log.warn(
          { messageId: message.id, accountId: message.accountId, err: errorMessage(error) },
          'mail classification prompt is too large',
        )
        continue
      }

      let admission:
        | { kind: 'paused'; status: MailSpendStatus }
        | { kind: 'classified'; decision: ClassifierOutput }
      try {
        admission = await withSerializedModelCall(async () => {
          const status = await getMailSpendStatus(db, {
            now,
            model: options.mail.model,
            maxInputChars: options.mail.maxInputChars,
            maxOutputTokens: options.mail.maxOutputTokens,
          })
          if (!status.canAdmit) return { kind: 'paused' as const, status }

          const decision = await withLlmCall(
            {
              db,
              log,
              runId: options.runId,
              purpose: 'classify_email',
              model: options.mail.model,
              reasoningEffort: options.mail.reasoningEffort,
              reservedCostUsd: status.reservationUsd,
            },
            async () => {
              try {
                const response = await options.classifier({
                  instructions: prompt.instructions,
                  input: prompt.input,
                  ...(options.signal !== undefined ? { signal: options.signal } : {}),
                })
                return { result: response.output, usage: response.usage }
              } catch (error) {
                throw modelCallError(error)
              }
            },
          )
          return { kind: 'classified' as const, decision }
        })
      } catch (error) {
        if (options.signal?.aborted) {
          const remaining = claimed.slice(index).map((row) => row.id)
          result.released += await releaseClaimedMessages(db, remaining, now)
          throw error
        }

        const kind = failureKind(error)
        if (kind === 'permanent') {
          await markTriagePermanentFailure(db, { id: message.id, error, now })
        } else {
          await markTriageTransientFailure(db, {
            id: message.id,
            attempts: claim.triageAttempts,
            error,
            now,
          })
        }
        result.failed += 1
        log.warn(
          {
            messageId: message.id,
            accountId: message.accountId,
            attempts: claim.triageAttempts,
            failureKind: kind,
            err: errorMessage(error),
          },
          'mail classification attempt failed',
        )
        continue
      }

      if (admission.kind === 'paused') {
        const remaining = claimed.slice(index).map((row) => row.id)
        result.released += await releaseClaimedMessages(db, remaining, now)
        result.pending = await countRunnableMessages(db, { now })
        await enqueueMailBudgetNotice(db, {
          status: admission.status,
          pending: result.pending,
          runId: options.runId,
        })
        result.paused = true
        break
      }

      await recordClassifierDecision(db, {
        messageId: message.id,
        runId: options.runId,
        decision: admission.decision,
        model: options.mail.model,
        promptVersion: prompt.promptVersion,
        classifierVersion: prompt.classifierVersion,
        reasoningEffort: options.mail.reasoningEffort,
        now,
      })
      result.classified += 1
    }
  } finally {
    // A thrown DB error leaves claims for the stale sweep; budget/shutdown paths release
    // explicitly above. This is intentionally a no-op unless something remains claimed.
    const unprocessed = claimed.slice(processed + 1).map((row) => row.id)
    if (unprocessed.length > 0 && options.signal?.aborted) {
      result.released += await releaseClaimedMessages(db, unprocessed, now).catch(() => 0)
    }
  }

  result.pending = await countRunnableMessages(db, { now })
  return result
}

export type { TriageMessage }
