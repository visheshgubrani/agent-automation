import type { RunTrigger } from '../audit/runs.js'
import { withRun } from '../audit/runs.js'
import { type Db, db as defaultDb } from '../db/index.js'
import { classifyTelegramSendError, errorMessage, type SendFailureKind } from '../errors.js'
import { type Logger, logger } from '../logger.js'
import { parseInlineButtonsFromPayload } from '../telegram/buttons.js'
import {
  TELEGRAM_BODY_LIMIT,
  TelegramBodyTooLongError,
  TelegramInvalidButtonsError,
  type TelegramSender,
} from '../telegram/sender.js'
import {
  claimNextDue,
  expireDue,
  hasDispatchWork,
  MAX_SEND_ATTEMPTS,
  markFailed,
  markQuarantined,
  markRetry,
  markSent,
  type NotificationRow,
  recoverStaleSending,
  retryDelaySeconds,
} from './outbox.js'

/** Maximum rows claimed and sent per dispatch tick. */
export const DISPATCH_LIMIT_PER_TICK = 10

export interface DispatchCounters {
  expired: number
  recoveredStale: number
  claimed: number
  sent: number
  retried: number
  quarantined: number
  failed: number
}

export interface DispatchOptions {
  /** Defaults to the module DB singleton. */
  db?: Db
  sender: TelegramSender
  /** Shutdown flag: stops new claims; the in-flight send finishes and finalizes. */
  signal?: AbortSignal
  limit?: number
  log?: Logger
}

/**
 * One dispatcher pass: expire overdue rows, recover stale `sending` rows by policy, then
 * claim → send → finalize one row at a time until the per-tick limit or the shutdown flag
 * stops the loop.
 *
 * Individual notifications may retry/quarantine/fail — those are row transitions, not
 * errors; only infrastructure/DB errors throw (and fail the enclosing run). Never logs
 * message bodies, only ids, counters, and bounded failure reasons.
 */
export async function dispatchPendingNotifications(
  options: DispatchOptions,
): Promise<DispatchCounters> {
  const db = options.db ?? defaultDb
  const log = options.log ?? logger
  const { signal } = options
  const counters: DispatchCounters = {
    expired: 0,
    recoveredStale: 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    quarantined: 0,
    failed: 0,
  }

  if (signal?.aborted) {
    return counters
  }

  counters.expired = await expireDue(db)
  const recovered = await recoverStaleSending(db)
  counters.recoveredStale = recovered.quarantined + recovered.requeued

  const limit = options.limit ?? DISPATCH_LIMIT_PER_TICK
  while (counters.claimed < limit && !signal?.aborted) {
    const row = await claimNextDue(db)
    if (!row) {
      break
    }
    counters.claimed += 1
    await deliverOne(db, options.sender, row, counters, log)
  }

  return counters
}

async function deliverOne(
  db: Db,
  sender: TelegramSender,
  row: NotificationRow,
  counters: DispatchCounters,
  log: Logger,
): Promise<void> {
  let failure: { kind: SendFailureKind; reason: string; retryAfterSeconds?: number }
  if (row.body.length > TELEGRAM_BODY_LIMIT) {
    // Deterministic permanent failure: rejected before any Telegram call, whichever
    // sender implementation is wired in (the sender guards this too).
    failure = {
      kind: 'permanent',
      reason: `body too long: ${row.body.length} > ${TELEGRAM_BODY_LIMIT} characters`,
    }
  } else {
    try {
      // Invalid or oversized payload buttons are omitted; the alert body still goes out.
      const buttons = parseInlineButtonsFromPayload(row.payload)
      const { messageId } = await sender.send(
        row.body,
        buttons === undefined ? undefined : { buttons },
      )
      // A failed finalize leaves the row `sending`; policy-aware recovery handles it and
      // the DB error propagates so the enclosing run records the infrastructure failure.
      await markSent(db, row.id, { telegramMessageId: messageId })
      counters.sent += 1
      log.debug(
        { notificationId: row.id, kind: row.kind, telegramMessageId: messageId },
        'notification sent',
      )
      return
    } catch (error) {
      failure = classifySendFailure(error)
    }
  }

  const exhausted = row.attemptCount >= MAX_SEND_ATTEMPTS
  const reason = exhausted
    ? `${failure.reason} (attempt ${row.attemptCount}/${MAX_SEND_ATTEMPTS})`
    : failure.reason

  if (failure.kind === 'uncertain' && row.deliveryPolicy === 'at_most_once') {
    // Delivery may or may not have happened; resending risks a duplicate. Terminal.
    await markQuarantined(db, row.id, `${reason}; delivery uncertain, not resent (at_most_once)`)
    counters.quarantined += 1
  } else if (failure.kind === 'permanent' || exhausted) {
    await markFailed(db, row.id, reason)
    counters.failed += 1
  } else {
    await markRetry(db, row.id, {
      reason,
      delaySeconds: retryDelaySeconds(row.attemptCount, failure.retryAfterSeconds),
    })
    counters.retried += 1
  }

  log.warn(
    {
      notificationId: row.id,
      kind: row.kind,
      deliveryPolicy: row.deliveryPolicy,
      failureKind: failure.kind,
      attempt: row.attemptCount,
      ...(failure.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: failure.retryAfterSeconds }
        : {}),
    },
    `notification send ${failure.kind === 'permanent' ? 'failed permanently' : failure.kind}`,
  )
}

/**
 * Map any send error to a narrow failure via `classifyTelegramSendError`; the typed
 * body-limit error is permanent by construction (it can never succeed on retry).
 */
function classifySendFailure(error: unknown): {
  kind: SendFailureKind
  reason: string
  retryAfterSeconds?: number
} {
  if (error instanceof TelegramBodyTooLongError) {
    return { kind: 'permanent', reason: errorMessage(error) }
  }
  if (error instanceof TelegramInvalidButtonsError) {
    return { kind: 'permanent', reason: errorMessage(error) }
  }
  const failure = classifyTelegramSendError(error)
  return {
    kind: failure.kind,
    reason: failure.reason,
    ...(failure.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
  }
}

export interface DispatchTickOptions extends DispatchOptions {
  trigger?: RunTrigger
  /** pg-boss job id, recorded on the run for trace (D020). */
  bossJobId?: string
}

export interface DispatchTickOutcome {
  /** False for idle ticks: no due/expired/stale work, no run opened (D020's exception). */
  runOpened: boolean
  result?: DispatchCounters
}

/**
 * The every-minute dispatch entry point: cheaply check for work first, open a
 * `notification_dispatch` run only when work exists, and run the dispatcher inside it.
 * If the pre-check itself throws, a failed run is opened so the infrastructure error is
 * still audited, then the error rethrows for pg-boss.
 */
export async function runDispatchTick(options: DispatchTickOptions): Promise<DispatchTickOutcome> {
  const db = options.db ?? defaultDb
  const log = options.log ?? logger
  const runOptions = { trigger: options.trigger ?? ('schedule' as RunTrigger) }

  let work: boolean
  try {
    work = await hasDispatchWork(db, {})
  } catch (error) {
    await withRun(
      {
        db,
        log,
        kind: 'notification_dispatch',
        ...runOptions,
        ...(options.bossJobId !== undefined ? { bossJobId: options.bossJobId } : {}),
      },
      async () => {
        throw error
      },
    ).catch(() => undefined)
    throw error
  }

  if (!work) {
    log.debug('dispatch tick idle: no due, expired, or stale sending work')
    return { runOpened: false }
  }

  const result = await withRun(
    {
      db,
      log,
      kind: 'notification_dispatch',
      ...runOptions,
      signal: options.signal,
      input: { gate: 'hasDispatchWork' },
      ...(options.bossJobId !== undefined ? { bossJobId: options.bossJobId } : {}),
    },
    async ({ log: runLog }) => {
      const counters = await dispatchPendingNotifications(options)
      // Counters only — never message bodies.
      runLog.info({ counters }, 'dispatch tick complete')
      return counters
    },
  )
  return { runOpened: true, result }
}
