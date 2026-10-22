import { and, eq, isNull, lte, or } from 'drizzle-orm'
import type { DbSession } from '../db/index.js'
import { accounts, mailboxSyncState } from '../db/schema/index.js'

export interface AccountDueForSync {
  id: string
  emailAddress: string
}

/** Active Gmail accounts whose persisted backoff has elapsed. Tiny accounts table; no new index. */
export async function listAccountsDueForSync(
  db: DbSession,
  now: Date = new Date(),
): Promise<AccountDueForSync[]> {
  return db
    .select({ id: accounts.id, emailAddress: accounts.emailAddress })
    .from(accounts)
    .leftJoin(mailboxSyncState, eq(mailboxSyncState.accountId, accounts.id))
    .where(
      and(
        eq(accounts.provider, 'gmail'),
        eq(accounts.status, 'active'),
        or(isNull(mailboxSyncState.backoffUntil), lte(mailboxSyncState.backoffUntil, now)),
      ),
    )
    .orderBy(accounts.emailAddress)
}
