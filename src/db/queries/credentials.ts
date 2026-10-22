import { and, eq } from 'drizzle-orm'
import {
  type CredentialEnvelope,
  decryptCredential,
  encryptCredential,
} from '../../crypto/credentials.js'
import type { KeyRing } from '../../crypto/keys.js'
import type { DbSession } from '../index.js'
import { accountCredentials, type credentialKind } from '../schema/index.js'

export type CredentialKind = (typeof credentialKind.enumValues)[number]

export interface UpsertCredentialOptions {
  accountId: string
  kind: CredentialKind
  /** Plaintext token material. Encrypted here; never stored, logged, or returned. */
  plaintext: string
  /** Access-token expiry; refresh tokens omit it. */
  expiresAt?: Date
}

/**
 * Encrypt and upsert the one credential row per `(account_id, kind)`.
 *
 * Conflict replaces the whole envelope (old ciphertext is dropped, `key_version` follows the
 * ring's active key) and bumps `updated_at`; there are no triggers. The Gmail connect and
 * refresh lifecycle call this inside their transactions.
 */
export async function upsertCredential(
  db: DbSession,
  ring: KeyRing,
  options: UpsertCredentialOptions,
): Promise<typeof accountCredentials.$inferSelect> {
  const context = { accountId: options.accountId, kind: options.kind }
  const envelope = encryptCredential(ring, context, options.plaintext)

  const expiresAt = options.expiresAt ?? null
  const [row] = await db
    .insert(accountCredentials)
    .values({
      accountId: options.accountId,
      kind: options.kind,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      authTag: envelope.authTag,
      keyVersion: envelope.keyVersion,
      expiresAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [accountCredentials.accountId, accountCredentials.kind],
      set: {
        ciphertext: envelope.ciphertext,
        nonce: envelope.nonce,
        authTag: envelope.authTag,
        keyVersion: envelope.keyVersion,
        expiresAt,
        updatedAt: new Date(),
      },
    })
    .returning()

  if (!row) {
    throw new Error('upsertCredential did not return a row')
  }
  return row
}

/**
 * Read and decrypt a credential with the key version stored on its row, including the
 * access-token expiry metadata. Returns null when no row exists yet.
 *
 * Decryption failures (tampered envelope, rotated-away key) throw typed crypto errors. The
 * returned plaintext must never be logged or persisted.
 */
export async function readCredentialRecord(
  db: DbSession,
  ring: KeyRing,
  accountId: string,
  kind: CredentialKind,
): Promise<{ plaintext: string; expiresAt: Date | null } | null> {
  const [row] = await db
    .select({
      ciphertext: accountCredentials.ciphertext,
      nonce: accountCredentials.nonce,
      authTag: accountCredentials.authTag,
      keyVersion: accountCredentials.keyVersion,
      expiresAt: accountCredentials.expiresAt,
    })
    .from(accountCredentials)
    .where(and(eq(accountCredentials.accountId, accountId), eq(accountCredentials.kind, kind)))
    .limit(1)

  if (!row) {
    return null
  }

  const envelope: CredentialEnvelope = {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.authTag,
    keyVersion: row.keyVersion,
  }
  return {
    plaintext: decryptCredential(ring, { accountId, kind }, envelope),
    expiresAt: row.expiresAt,
  }
}

/** Read only the decrypted token; see `readCredentialRecord` for expiry metadata. */
export async function readCredential(
  db: DbSession,
  ring: KeyRing,
  accountId: string,
  kind: CredentialKind,
): Promise<string | null> {
  const record = await readCredentialRecord(db, ring, accountId, kind)
  return record?.plaintext ?? null
}
