import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { accountProvider, accountStatus, credentialKind } from './enums.js'
import { bytea, timestamps } from './types.js'

/** Gmail inboxes (and later outreach sending inboxes). No secrets live here. */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: accountProvider('provider').notNull(),
    emailAddress: text('email_address').notNull(),
    displayName: text('display_name'),
    // Scopes actually granted by Google, e.g. .../gmail.readonly or .../gmail.compose.
    grantedScopes: text('granted_scopes').array().notNull().default(sql`'{}'::text[]`),
    status: accountStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('accounts_email_address_lower_uq').on(sql`lower(${t.emailAddress})`)],
)

/** Encrypted OAuth material. Plaintext tokens never enter the database. */
export const accountCredentials = pgTable(
  'account_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: credentialKind('kind').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    authTag: bytea('auth_tag').notNull(),
    keyVersion: smallint('key_version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('account_credentials_account_kind_uq').on(t.accountId, t.kind),
    check('account_credentials_key_version_check', sql`${t.keyVersion} > 0`),
    check('account_credentials_ciphertext_check', sql`octet_length(${t.ciphertext}) > 0`),
    check('account_credentials_nonce_check', sql`octet_length(${t.nonce}) = 12`),
    check('account_credentials_auth_tag_check', sql`octet_length(${t.authTag}) = 16`),
  ],
)

/** Cursor and health for one Gmail account. */
export const mailboxSyncState = pgTable(
  'mailbox_sync_state',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    historyId: text('history_id'),
    // Expired/invalid Gmail history ids are routine; a full resync is a normal state.
    needsFullResync: boolean('needs_full_resync').notNull().default(false),
    // Mail received after this instant is eligible for automatic alerts. Set once on the
    // first successful connection; reconnecting or resyncing must not reset it.
    notificationBoundaryAt: timestamp('notification_boundary_at', { withTimezone: true }),
    initialSyncCompletedAt: timestamp('initial_sync_completed_at', { withTimezone: true }),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    backoffUntil: timestamp('backoff_until', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check('mailbox_sync_state_failures_check', sql`${t.consecutiveFailures} >= 0`)],
)
