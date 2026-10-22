import { withRun } from '../audit/runs.js'
import type { MailConfig } from '../config.js'
import { db } from '../db/index.js'
import { type Logger, logger } from '../logger.js'
import type { MailClassifier } from '../mail/openai-classifier.js'
import { type MailTriageResult, runMailTriage, triagePreflight } from '../mail/triage.js'
import type { MailTriageJobData } from '../queue.js'

export interface MailTriageJobContext {
  jobId: string
  data?: MailTriageJobData
  mail: MailConfig
  classifier: MailClassifier
  signal?: AbortSignal
  now?: Date
  log?: Logger
}

export interface MailTriageJobResult {
  runOpened: boolean
  paused: boolean
  pending: number
  result?: MailTriageResult
}

/**
 * Every-minute triage consumer. A cheap preflight avoids opening an audit run when the budget
 * is exhausted and no rule can make progress; otherwise one `mail_triage` run processes a
 * bounded fair batch.
 */
export async function handleMailTriageJob(
  context: MailTriageJobContext,
): Promise<MailTriageJobResult> {
  const log = context.log ?? logger
  const now = context.now ?? new Date()

  const preflight = await triagePreflight({ db, mail: context.mail, now, log })
  if (!preflight.run) {
    log.debug(
      { pending: preflight.pending, paused: preflight.paused },
      'mail triage preflight skipped',
    )
    return {
      runOpened: false,
      paused: preflight.paused,
      pending: preflight.pending,
    }
  }

  const result = await withRun(
    {
      kind: 'mail_triage',
      trigger: context.data?.source === 'manual' ? 'manual' : 'schedule',
      input: { job: 'triage' },
      bossJobId: context.jobId,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      log,
    },
    async ({ run, log: runLog }) =>
      runMailTriage({
        db,
        runId: run.id,
        mail: context.mail,
        classifier: context.classifier,
        now,
        log: runLog,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      }),
  )

  runCounters(log, result)
  return {
    runOpened: true,
    paused: result.paused,
    pending: result.pending,
    result,
  }
}

function runCounters(log: Logger, result: MailTriageResult): void {
  log.info(
    {
      rulesApplied: result.rulesApplied,
      classified: result.classified,
      failed: result.failed,
      paused: result.paused,
      released: result.released,
      pending: result.pending,
    },
    'mail triage complete',
  )
}
