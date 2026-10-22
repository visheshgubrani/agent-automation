import type { Logger } from '../logger.js'
import { type DispatchTickOutcome, runDispatchTick } from '../notifications/dispatcher.js'
import type { TelegramSender } from '../telegram/sender.js'

export interface DispatchJobContext {
  /** pg-boss job id, stored on the tick's run when one is opened. */
  jobId: string
  /** Built once from worker config; sends to the single configured chat. */
  sender: TelegramSender
  /** Worker-shutdown flag: stops new claims, lets the in-flight send finish. */
  signal?: AbortSignal
  log?: Logger
}

/**
 * pg-boss handler for the every-minute dispatch tick. All logic (idle gate, run opening,
 * dispatch loop) lives in `runDispatchTick`; this wrapper exists to carry the pg-boss job
 * id into `runs.boss_job_id` for trace.
 */
export async function handleDispatchJob(context: DispatchJobContext): Promise<DispatchTickOutcome> {
  return runDispatchTick({
    sender: context.sender,
    signal: context.signal,
    log: context.log,
    bossJobId: context.jobId,
  })
}
