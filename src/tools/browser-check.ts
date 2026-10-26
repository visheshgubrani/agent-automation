import { parseArgs } from 'node:util'
import { parseCheckUrl, runBrowserCheck } from '../browser/check.js'
import { requireBrowserCheckConfig } from '../config.js'
import { env } from '../env.js'
import { errorMessage } from '../errors.js'

const USAGE = `Usage:
  pnpm browser:check                    # local test page, no network
  pnpm browser:check --snapshot <url>   # print a bounded snapshot of an http(s) page`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      snapshot: { type: 'string' },
      'max-chars': { type: 'string' },
    },
  })

  const config = requireBrowserCheckConfig(env)
  const url = values.snapshot !== undefined ? parseCheckUrl(values.snapshot) : undefined
  const maxChars = values['max-chars'] !== undefined ? Number(values['max-chars']) : undefined
  if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 100)) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  const result = await runBrowserCheck({
    cdpUrl: config.cdpUrl,
    ...(url !== undefined ? { url } : {}),
    ...(config.artifactDir !== undefined ? { artifactDir: config.artifactDir } : {}),
    ...(maxChars !== undefined ? { maxSnapshotChars: maxChars } : {}),
  })

  console.log(`Connected: Chromium ${result.browserVersion} over CDP (${config.cdpUrl})`)
  console.log(`Profile context reused: ${result.reusedContext ? 'yes' : 'no'}`)
  console.log(`Page: ${url !== undefined ? result.pageUrl : 'local check page'}`)
  console.log(
    `Snapshot: ${result.snapshot.text.length} of ${result.snapshot.totalChars} chars` +
      `${result.snapshot.truncated ? ' (truncated)' : ''}; ref resolution ` +
      `${result.refResolved ? 'ok' : 'FAILED'}`,
  )
  console.log(
    `Screenshot: ${result.screenshot.byteSize} bytes` +
      (result.screenshot.storagePath !== undefined
        ? ` stored as ${result.screenshot.storagePath}`
        : ' (not stored; ARTIFACT_DIR unset)'),
  )
  // The snapshot is printed only for an explicit --snapshot URL; it is untrusted page text.
  if (url !== undefined) {
    console.log('--- snapshot (untrusted page content) ---')
    console.log(result.snapshot.text)
    console.log('--- end snapshot ---')
  }
  if (!result.refResolved) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(`browser:check failed: ${errorMessage(error)}`)
  process.exitCode = 1
})
