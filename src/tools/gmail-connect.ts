import { parseArgs } from 'node:util'
import { ConfigError, requireGmailConnectConfig } from '../config.js'
import { db, pool } from '../db/index.js'
import { env } from '../env.js'
import { errorMessage } from '../errors.js'
import { connectGmailAccount } from '../gmail/connect.js'
import { OAuthFlowError, openBrowser } from '../gmail/oauth.js'

const USAGE = `Usage: pnpm gmail:connect --email <address> [--no-browser]

Runs the local Desktop OAuth flow, verifies the Gmail account and gmail.readonly scope,
then stores the account and encrypted credentials. No token is printed.`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string', short: 'e' },
      'no-browser': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  if (!values.email) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  const config = requireGmailConnectConfig(env)
  const result = await connectGmailAccount({
    db,
    config,
    email: values.email,
    onAuthUrl: (url) => {
      console.log('Authorize Gmail for the requested account in your browser:')
      console.log(url)
      if (!values['no-browser']) {
        openBrowser(url)
      }
    },
  })

  console.log(`Connected ${result.authorizedEmail} (account ${result.account.id}).`)
  console.log(`Granted scopes: ${result.grantedScopes.join(', ')}`)
  console.log(
    result.boundarySet
      ? 'Notification boundary set at the first successful connection.'
      : 'Existing notification boundary and sync history preserved.',
  )
  console.log(
    result.refreshPreserved
      ? 'Google omitted a new refresh token; the existing encrypted refresh token was preserved.'
      : 'Refresh token stored encrypted.',
  )
}

main()
  .catch((error) => {
    console.error(error instanceof ConfigError ? error.message : errorMessage(error))
    if (error instanceof OAuthFlowError) {
      console.error('The local OAuth flow did not complete; nothing was saved.')
    }
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
