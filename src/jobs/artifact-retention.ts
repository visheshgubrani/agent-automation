import { withRun } from '../audit/runs.js'
import { retainArtifacts } from '../browser/artifacts.js'
import { type Db, db as defaultDb } from '../db/index.js'
import type { Logger } from '../logger.js'

export async function handleArtifactRetentionJob(options: {
  jobId: string
  artifactDir: string
  db?: Db
  log?: Logger
  now?: Date
  signal?: AbortSignal
}) {
  const db = options.db ?? defaultDb
  return withRun(
    {
      db,
      ...(options.log ? { log: options.log } : {}),
      kind: 'system',
      trigger: 'schedule',
      bossJobId: options.jobId,
      input: { job: 'artifact-retention' },
      ...(options.signal ? { signal: options.signal } : {}),
    },
    async ({ log }) => {
      const result = await retainArtifacts(db, options.artifactDir, options.now, options.signal)
      if (result.failed) log.warn(result, 'some expired artifacts could not be removed')
      return result
    },
  )
}
