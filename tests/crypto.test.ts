import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CREDENTIAL_AUTH_TAG_BYTES,
  CREDENTIAL_NONCE_BYTES,
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
} from '../src/crypto/credentials.js'
import { parseKeyRing } from '../src/crypto/keys.js'
import { readCredential, upsertCredential } from '../src/db/queries/credentials.js'
import { accountCredentials } from '../src/db/schema/index.js'
import { createAccount } from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

// Same deterministic ring as vitest.config.ts (version 1 = 32 bytes of 0x07).
const ring = parseKeyRing(process.env.TOKEN_ENCRYPTION_KEYS ?? '', 1)
// A different key with the same version: decryption must fail closed.
const wrongKeyRing = parseKeyRing(`1:${Buffer.alloc(32, 9).toString('base64')}`, 1)
// Ring holding two versions with 2 active, for decrypt-with-row-version coverage.
const rotatedRing = parseKeyRing(
  `${process.env.TOKEN_ENCRYPTION_KEYS ?? ''},2:${Buffer.alloc(32, 11).toString('base64')}`,
  2,
)

const CONTEXT = { accountId: '11111111-1111-1111-1111-111111111111', kind: 'oauth_refresh_token' }
const PLAINTEXT = 'ya29.secret-refresh-token-value'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('encrypt/decrypt round trip', () => {
  it('round-trips plaintext and produces the stored envelope shape', () => {
    const envelope = encryptCredential(ring, CONTEXT, PLAINTEXT)

    expect(envelope.keyVersion).toBe(1)
    expect(envelope.nonce).toHaveLength(CREDENTIAL_NONCE_BYTES)
    expect(envelope.authTag).toHaveLength(CREDENTIAL_AUTH_TAG_BYTES)
    expect(envelope.ciphertext.length).toBeGreaterThan(0)
    expect(envelope.ciphertext.equals(Buffer.from(PLAINTEXT, 'utf8'))).toBe(false)

    expect(decryptCredential(ring, CONTEXT, envelope)).toBe(PLAINTEXT)
  })

  it('uses a fresh nonce per encryption, so identical plaintext encrypts differently', () => {
    const a = encryptCredential(ring, CONTEXT, PLAINTEXT)
    const b = encryptCredential(ring, CONTEXT, PLAINTEXT)

    expect(a.nonce.equals(b.nonce)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    expect(decryptCredential(ring, CONTEXT, a)).toBe(PLAINTEXT)
    expect(decryptCredential(ring, CONTEXT, b)).toBe(PLAINTEXT)
  })

  it('encrypts with the active key version and decrypts with the row key version', () => {
    const envelope = encryptCredential(rotatedRing, CONTEXT, PLAINTEXT)
    expect(envelope.keyVersion).toBe(2)

    // The same ring reads its own old and new rows.
    expect(decryptCredential(rotatedRing, CONTEXT, envelope)).toBe(PLAINTEXT)
    // A ring that rotated away version 2 can no longer read it.
    expect(() => decryptCredential(ring, CONTEXT, envelope)).toThrow(CredentialCryptoError)
  })
})

describe('rejects invalid input with typed errors', () => {
  it('rejects empty plaintext before touching the key', () => {
    expect(() => encryptCredential(ring, CONTEXT, '')).toThrow(CredentialCryptoError)
    try {
      encryptCredential(ring, CONTEXT, '')
    } catch (error) {
      expect((error as CredentialCryptoError).reason).toBe('empty_plaintext')
    }
  })

  it('rejects an unknown key version on decrypt', () => {
    const envelope = { ...encryptCredential(ring, CONTEXT, PLAINTEXT), keyVersion: 99 }
    try {
      decryptCredential(ring, CONTEXT, envelope)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialCryptoError)
      expect((error as CredentialCryptoError).reason).toBe('unknown_key_version')
    }
  })

  it('rejects malformed envelopes', () => {
    const envelope = encryptCredential(ring, CONTEXT, PLAINTEXT)
    expect(() => decryptCredential(ring, CONTEXT, { ...envelope, nonce: Buffer.alloc(4) })).toThrow(
      CredentialCryptoError,
    )
    expect(() =>
      decryptCredential(ring, CONTEXT, { ...envelope, authTag: Buffer.alloc(8) }),
    ).toThrow(CredentialCryptoError)
    expect(() =>
      decryptCredential(ring, CONTEXT, { ...envelope, ciphertext: Buffer.alloc(0) }),
    ).toThrow(CredentialCryptoError)
  })
})

describe('fails closed on tampering or context mismatch', () => {
  const expectDecryptionFailed = (error: unknown): void => {
    expect(error).toBeInstanceOf(CredentialCryptoError)
    expect((error as CredentialCryptoError).reason).toBe('decryption_failed')
  }

  /** Flip one bit of a copy so tests never mutate a shared envelope. */
  const tampered = (buffer: Buffer): Buffer => {
    const copy = Buffer.from(buffer)
    copy[0] = copy[0] ^ 1
    return copy
  }

  it('rejects tampered ciphertext', () => {
    const envelope = encryptCredential(ring, CONTEXT, PLAINTEXT)
    try {
      decryptCredential(ring, CONTEXT, { ...envelope, ciphertext: tampered(envelope.ciphertext) })
      expect.unreachable()
    } catch (error) {
      expectDecryptionFailed(error)
    }
  })

  it('rejects a tampered auth tag', () => {
    const envelope = encryptCredential(ring, CONTEXT, PLAINTEXT)
    try {
      decryptCredential(ring, CONTEXT, { ...envelope, authTag: tampered(envelope.authTag) })
      expect.unreachable()
    } catch (error) {
      expectDecryptionFailed(error)
    }
  })

  it('rejects the wrong key at the same version', () => {
    const envelope = encryptCredential(ring, CONTEXT, PLAINTEXT)
    try {
      decryptCredential(wrongKeyRing, CONTEXT, envelope)
      expect.unreachable()
    } catch (error) {
      expectDecryptionFailed(error)
    }
  })

  it('binds the envelope to accountId, kind, and key version via AAD', () => {
    const envelope = encryptCredential(ring, CONTEXT, PLAINTEXT)

    try {
      decryptCredential(
        ring,
        { ...CONTEXT, accountId: '22222222-2222-2222-2222-222222222222' },
        envelope,
      )
      expect.unreachable()
    } catch (error) {
      expectDecryptionFailed(error)
    }
    try {
      decryptCredential(ring, { ...CONTEXT, kind: 'oauth_access_token' }, envelope)
      expect.unreachable()
    } catch (error) {
      expectDecryptionFailed(error)
    }
  })
})

describe('credential storage helpers', () => {
  it('stores ciphertext only: plaintext bytes never reach any column', async () => {
    const account = await createAccount()
    await upsertCredential(db, ring, {
      accountId: account.id,
      kind: 'oauth_refresh_token',
      plaintext: PLAINTEXT,
    })

    const [row] = await db.select().from(accountCredentials)
    expect(row?.keyVersion).toBe(1)
    expect(row?.nonce).toHaveLength(CREDENTIAL_NONCE_BYTES)
    expect(row?.authTag).toHaveLength(CREDENTIAL_AUTH_TAG_BYTES)
    expect(row?.ciphertext.length).toBeGreaterThan(0)
    expect(row?.ciphertext.toString('utf8')).not.toContain(PLAINTEXT)
  })

  it('upserts one row per (account, kind) and reads back the latest plaintext', async () => {
    const account = await createAccount()

    await upsertCredential(db, ring, {
      accountId: account.id,
      kind: 'oauth_refresh_token',
      plaintext: PLAINTEXT,
    })
    await upsertCredential(db, ring, {
      accountId: account.id,
      kind: 'oauth_refresh_token',
      plaintext: 'rotated-token',
    })
    await upsertCredential(db, ring, {
      accountId: account.id,
      kind: 'oauth_access_token',
      plaintext: 'access-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    })

    const rows = await db.select().from(accountCredentials)
    expect(rows).toHaveLength(2)

    expect(await readCredential(db, ring, account.id, 'oauth_refresh_token')).toBe('rotated-token')
    expect(await readCredential(db, ring, account.id, 'oauth_access_token')).toBe('access-token')
  })

  it('returns null when no credential row exists', async () => {
    const account = await createAccount()
    expect(await readCredential(db, ring, account.id, 'oauth_refresh_token')).toBeNull()
  })
})
