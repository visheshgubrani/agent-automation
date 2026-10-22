import type { Db } from '../db/index.js'
import {
  type AccountRow,
  findAccountByEmail,
  listAccountSummaries,
  setAccountStatus,
} from '../db/queries/accounts.js'
import { GMAIL_READONLY_SCOPE } from '../gmail/constants.js'

export type MailAccountErrorReason = 'not_found' | 'revoked' | 'missing_scope'

export class MailAccountError extends Error {
  readonly reason: MailAccountErrorReason

  constructor(reason: MailAccountErrorReason, message: string) {
    super(message)
    this.name = 'MailAccountError'
    this.reason = reason
  }
}

export { listAccountSummaries }

async function requireAccount(db: Db, email: string): Promise<AccountRow> {
  const account = await findAccountByEmail(db, email)
  if (!account) {
    throw new MailAccountError('not_found', `no connected account matches ${email.trim()}`)
  }
  return account
}

/** Pause a connected mailbox. Revoked accounts must be reconnected instead. */
export async function pauseMailAccount(db: Db, email: string): Promise<AccountRow> {
  const account = await requireAccount(db, email)
  if (account.status === 'revoked') {
    throw new MailAccountError(
      'revoked',
      `account ${account.emailAddress} is revoked; run pnpm gmail:connect --email ${account.emailAddress}`,
    )
  }
  if (account.status === 'paused') {
    return account
  }
  return setAccountStatus(db, account.id, 'paused')
}

/**
 * Resume a paused/errored mailbox. A revoked grant or missing gmail.readonly scope requires a
 * fresh OAuth connection rather than silently reactivating an unusable account.
 */
export async function resumeMailAccount(db: Db, email: string): Promise<AccountRow> {
  const account = await requireAccount(db, email)
  if (account.status === 'revoked') {
    throw new MailAccountError(
      'revoked',
      `account ${account.emailAddress} is revoked; run pnpm gmail:connect --email ${account.emailAddress}`,
    )
  }
  if (!account.grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
    throw new MailAccountError(
      'missing_scope',
      `account ${account.emailAddress} lacks ${GMAIL_READONLY_SCOPE}; reconnect it before resuming`,
    )
  }
  if (account.status === 'active') {
    return account
  }
  return setAccountStatus(db, account.id, 'active')
}
