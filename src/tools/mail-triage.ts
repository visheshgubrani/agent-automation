import { parseArgs } from 'node:util'
import { db, pool } from '../db/index.js'
import { env } from '../env.js'
import { errorMessage } from '../errors.js'
import { getMailSpendStatus } from '../mail/budget.js'
import {
  countExhaustedTriage,
  countPendingMessages,
  countRunnableMessages,
  countTriageFailures,
  requeueFailedTriage,
} from '../mail/triage-state.js'

const USAGE = `Usage:
  pnpm mail:triage status
  pnpm mail:triage retry-failed --id <message-id>
  pnpm mail:triage retry-failed --all`

function formatUsd(value: number | null): string {
  return value === null ? 'no limit' : `$${value.toFixed(4)}`
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      all: { type: 'boolean', default: false },
      id: { type: 'string' },
    },
    allowPositionals: true,
  })
  const [command] = positionals

  switch (command) {
    case 'status': {
      const [pending, runnable, failed, exhausted] = await Promise.all([
        countPendingMessages(db),
        countRunnableMessages(db),
        countTriageFailures(db),
        countExhaustedTriage(db),
      ])
      const spend = await getMailSpendStatus(db, {
        model: env.MAIL_MODEL,
        maxInputChars: env.MAIL_MAX_INPUT_CHARS,
        maxOutputTokens: env.MAIL_MAX_OUTPUT_TOKENS,
      })

      const limit =
        spend.settings.dailyLimitUsd === null
          ? 'no daily limit'
          : `${formatUsd(spend.settings.dailyLimitUsd)} limit`
      const remaining =
        spend.remainingUsd === null ? '' : `; ${formatUsd(spend.remainingUsd)} remaining`
      console.log(`Backlog: ${pending} pending/in-progress/failed, ${runnable} runnable now`)
      console.log(`Failures: ${failed} failed, ${exhausted} exhausted (retry-failed to requeue)`)
      console.log(
        `Spend ${spend.range.dayKey} (${spend.settings.timezone}): ` +
          `${formatUsd(spend.usage.actualUsd)} actual, ` +
          `${formatUsd(spend.usage.reservedUsd)} held by in-flight/unknown calls, ` +
          `${formatUsd(spend.usage.totalUsd)} counted toward ${limit}` +
          `${remaining}; ${formatUsd(spend.reservationUsd)} per classifier call`,
      )
      return
    }
    case 'retry-failed': {
      if (!values.all && !values.id) {
        console.error(USAGE)
        process.exitCode = 1
        return
      }
      const count = await requeueFailedTriage(db, {
        ...(values.id !== undefined ? { ids: [values.id] } : {}),
      })
      console.log(`Requeued ${count} message(s) for classification.`)
      return
    }
    default:
      console.error(USAGE)
      process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
