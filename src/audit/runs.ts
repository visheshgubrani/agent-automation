import { eq } from 'drizzle-orm'
import { type Db, db as defaultDb } from '../db/index.js'
import { type runKind, type runStatus, runs, type runTrigger } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import { type Logger, logger } from '../logger.js'

export type RunKind = (typeof runKind.enumValues)[number]
export type RunTrigger = (typeof runTrigger.enumValues)[number]
export type RunTerminalStatus = Exclude<(typeof runStatus.enumValues)[number], 'running'>
export type RunRow = typeof runs.$inferSelect

/** Upper bound for `runs.error`; matches the bounded serializers in src/errors.ts. */
const RUN_ERROR_LIMIT = 1000

/** Thrown when a run is refused before it starts because shutdown was already requested. */
export class RunNotStartedError extends Error {
  constructor(message = 'run not started: shutdown already requested') {
    super(message)
    this.name = 'RunNotStartedError'
  }
}

export interface StartRunOptions {
  kind: RunKind
  trigger: RunTrigger
  /**
   * Ids/references only (message ids, account ids, job counters). Never message bodies,
   * user content, or secrets — `runs.input` is audit metadata, not storage.
   */
  input?: Record<string, unknown>
  parentRunId?: string
  /** pg-boss job id, for correlating a run with its orchestration record. */
  bossJobId?: string
}

export interface RunContext {
  run: RunRow
  /** Child logger with run context (`runId`, `runKind`, `bossJobId`). */
  log: Logger
}

export interface WithRunOptions extends StartRunOptions {
  /** Defaults to the module DB singleton. */
  db?: Db
  /** Base logger; defaults to the module root logger. */
  log?: Logger
  /**
   * Worker-shutdown signal. Aborted while the handler runs → the run is recorded
   * `cancelled`; aborted before it starts → no run row and a RunNotStartedError, so
   * pg-boss can retry the job later.
   */
  signal?: AbortSignal
}

/** Open a run row (`status = 'running'`). Callers finalize it with `finishRun` or `withRun`. */
export async function startRun(db: Db, options: StartRunOptions): Promise<RunRow> {
  const [run] = await db
    .insert(runs)
    .values({
      kind: options.kind,
      trigger: options.trigger,
      input: options.input ?? {},
      ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
      ...(options.bossJobId !== undefined ? { bossJobId: options.bossJobId } : {}),
    })
    .returning()

  if (!run) {
    throw new Error('startRun did not return a run row')
  }
  return run
}

/**
 * Finalize a run with a terminal status. `finished_at` is always set (the DB check requires
 * it) and `error` is stored as bounded, secret-safe text via `errorMessage`.
 */
export async function finishRun(
  db: Db,
  runId: string,
  status: RunTerminalStatus,
  error?: unknown,
): Promise<void> {
  await db
    .update(runs)
    .set({
      status,
      finishedAt: new Date(),
      ...(error !== undefined ? { error: errorMessage(error, RUN_ERROR_LIMIT) } : {}),
    })
    .where(eq(runs.id, runId))
}

/**
 * Run-scoped audit wrapper: opens a run, executes the handler with a child logger, and
 * finalizes the row before returning/rethrowing.
 *
 * - handler resolves → `succeeded`
 * - handler throws with the signal aborted → `cancelled`
 * - handler throws otherwise → `failed`, with bounded error text
 *
 * The original error is always rethrown so pg-boss can retry the job. If the finalize write
 * itself fails (DB down at the end), the failure is logged but the handler's outcome wins —
 * the work already happened, and failing it would trigger duplicate side effects.
 *
 * Every work-performing pg-boss handler and accepted bot update must use `withRun`; idle
 * dispatch ticks are the documented exception (D020).
 */
export async function withRun<T>(
  options: WithRunOptions,
  handler: (context: RunContext) => Promise<T>,
): Promise<T> {
  const db = options.db ?? defaultDb
  const baseLog = options.log ?? logger
  const { signal } = options

  if (signal?.aborted) {
    throw new RunNotStartedError()
  }

  const run = await startRun(db, options)
  const log = baseLog.child({
    runId: run.id,
    runKind: options.kind,
    ...(options.bossJobId !== undefined ? { bossJobId: options.bossJobId } : {}),
  })

  try {
    const result = await handler({ run, log })
    try {
      await finishRun(db, run.id, 'succeeded')
    } catch (finishError) {
      log.error({ err: errorMessage(finishError) }, 'failed to record run success')
    }
    return result
  } catch (error) {
    const status: RunTerminalStatus = signal?.aborted ? 'cancelled' : 'failed'
    try {
      await finishRun(db, run.id, status, error)
    } catch (finishError) {
      log.error(
        { err: errorMessage(finishError), runStatus: status },
        'failed to record run failure',
      )
    }
    throw error
  }
}
