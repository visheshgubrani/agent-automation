import { normalizeEmailAddress } from '../mail/normalize.js'

export type GmailConnectErrorReason =
  | 'token_exchange_failed'
  | 'missing_access_token'
  | 'scope_verification_failed'
  | 'missing_scope'
  | 'unexpected_scope'
  | 'profile_verification_failed'
  | 'email_mismatch'

export class GmailConnectError extends Error {
  readonly reason: GmailConnectErrorReason

  constructor(reason: GmailConnectErrorReason, message: string) {
    super(message)
    this.name = 'GmailConnectError'
    this.reason = reason
  }
}

/** Compare the intended account with Google's profile, case-insensitively. */
export function assertGmailAccountMatches(requested: string, authorized: string): string {
  const expected = normalizeEmailAddress(requested)
  const actual = normalizeEmailAddress(authorized)
  if (actual !== expected) {
    throw new GmailConnectError(
      'email_mismatch',
      `Google authorized ${actual}, which does not match the requested ${expected}; retry with the intended account`,
    )
  }
  return actual
}
