import { parseArgs } from 'node:util'
import type { MailConfig, MailReasoningEffort } from '../config.js'
import { env } from '../env.js'
import { errorMessage } from '../errors.js'
import {
  computeEvaluationMetrics,
  formatEvaluationReport,
  runEvaluation,
} from '../mail/evaluation.js'
import { createOpenAiMailClassifier } from '../mail/openai-classifier.js'
import { isSupportedMailModel } from '../mail/pricing.js'

const USAGE = `Usage:
  pnpm mail:evaluate [--effort medium|high|both] [--json]

Runs the labeled held-out evaluation set through the real classifier. Requires OPENAI_API_KEY.
The synthetic dataset contains no private mail.`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      effort: { type: 'string', default: 'both' },
      json: { type: 'boolean', default: false },
    },
  })

  const effort = values.effort
  if (effort !== 'medium' && effort !== 'high' && effort !== 'both') {
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  if (!env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is required for mail:evaluate; live evaluation is pending.')
    process.exitCode = 1
    return
  }
  if (!isSupportedMailModel(env.MAIL_MODEL)) {
    console.error(`MAIL_MODEL "${env.MAIL_MODEL}" has no configured pricing snapshot.`)
    process.exitCode = 1
    return
  }

  const baseConfig: Omit<MailConfig, 'reasoningEffort'> = {
    gmail: {
      clientId: env.GMAIL_CLIENT_ID ?? 'unused-for-evaluation',
      clientSecret: env.GMAIL_CLIENT_SECRET ?? 'unused-for-evaluation',
    },
    openaiApiKey: env.OPENAI_API_KEY,
    model: env.MAIL_MODEL,
    maxInputChars: env.MAIL_MAX_INPUT_CHARS,
    maxOutputTokens: env.MAIL_MAX_OUTPUT_TOKENS,
    requestTimeoutMs: env.MAIL_REQUEST_TIMEOUT_MS,
    gmailRequestDelayMs: env.GMAIL_REQUEST_DELAY_MS,
  }

  const efforts: MailReasoningEffort[] = effort === 'both' ? ['medium', 'high'] : [effort]

  for (const selected of efforts) {
    const classifier = createOpenAiMailClassifier({ ...baseConfig, reasoningEffort: selected })
    const results = await runEvaluation({
      classifier,
      maxInputChars: env.MAIL_MAX_INPUT_CHARS,
    })
    if (values.json) {
      console.log(
        JSON.stringify({
          effort: selected,
          metrics: computeEvaluationMetrics(results),
          results,
        }),
      )
    } else {
      console.log(formatEvaluationReport(selected, results))
      console.log('')
    }
  }
}

main().catch((error) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
