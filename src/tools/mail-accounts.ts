import { parseArgs } from 'node:util'
import { db, pool } from '../db/index.js'
import { errorMessage } from '../errors.js'
import { listAccountSummaries, pauseMailAccount, resumeMailAccount } from '../mail/accounts.js'

const USAGE = `Usage:
  pnpm mail:accounts list
  pnpm mail:accounts pause <email>
  pnpm mail:accounts resume <email>`

function formatDate(value: Date | null): string {
  return value ? value.toISOString() : '-'
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true })
  const [command, email] = positionals

  switch (command) {
    case 'list': {
      const accounts = await listAccountSummaries(db)
      if (accounts.length === 0) {
        console.log('No accounts connected.')
        return
      }
      for (const account of accounts) {
        console.log(`${account.emailAddress} [${account.status}]`)
        console.log(`  id: ${account.id}`)
        console.log(`  scopes: ${account.grantedScopes.join(', ') || '-'}`)
        console.log(`  notification boundary: ${formatDate(account.notificationBoundaryAt)}`)
        console.log(`  last polled: ${formatDate(account.lastPolledAt)}`)
        console.log(`  last success: ${formatDate(account.lastSuccessAt)}`)
        console.log(`  last failure: ${formatDate(account.lastFailureAt)}`)
        if (account.consecutiveFailures > 0) {
          console.log(`  consecutive failures: ${account.consecutiveFailures}`)
        }
        if (account.lastError) console.log(`  last error: ${account.lastError}`)
      }
      return
    }
    case 'pause':
    case 'resume': {
      if (!email) {
        console.error(USAGE)
        process.exitCode = 1
        return
      }
      const account =
        command === 'pause' ? await pauseMailAccount(db, email) : await resumeMailAccount(db, email)
      console.log(`${account.emailAddress} is now ${account.status}.`)
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
