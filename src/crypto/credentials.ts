import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { activeKey, type KeyRing, keyForVersion } from './keys.js'

/** `account_credentials.nonce`: 12-byte GCM IV, freshly random per encryption. */
export const CREDENTIAL_NONCE_BYTES = 12

/** `account_credentials.auth_tag`: 16-byte GCM authentication tag. */
export const CREDENTIAL_AUTH_TAG_BYTES = 16

/** AES-256-GCM keys are exactly 32 bytes (see src/crypto/keys.ts). */
const KEY_BYTES = 32
const ALGORITHM = 'aes-256-gcm'

/** Why a credential operation failed. Messages never contain plaintext or key material. */
export type CredentialCryptoErrorReason =
  | 'empty_plaintext'
  | 'invalid_envelope'
  | 'unknown_key_version'
  | 'decryption_failed'

export class CredentialCryptoError extends Error {
  readonly reason: CredentialCryptoErrorReason

  constructor(reason: CredentialCryptoErrorReason, message: string) {
    super(message)
    this.name = 'CredentialCryptoError'
    this.reason = reason
  }
}

/** The stored credential envelope; maps 1:1 onto the `account_credentials` bytea columns. */
export interface CredentialEnvelope {
  ciphertext: Buffer
  nonce: Buffer
  authTag: Buffer
  keyVersion: number
}

/** Row identity bound into the GCM additional authenticated data. */
export interface CredentialContext {
  accountId: string
  kind: string
}

/**
 * AAD binds ciphertext to its row identity and key version, so an envelope copied to another
 * account, another kind, or re-tagged with another key version fails authentication.
 */
function aad(context: CredentialContext, keyVersion: number): Buffer {
  return Buffer.from(`${context.accountId}:${context.kind}:${keyVersion}`, 'utf8')
}

function assertEnvelopeShape(envelope: CredentialEnvelope): void {
  if (
    !Buffer.isBuffer(envelope.ciphertext) ||
    envelope.ciphertext.length === 0 ||
    !Buffer.isBuffer(envelope.nonce) ||
    envelope.nonce.length !== CREDENTIAL_NONCE_BYTES ||
    !Buffer.isBuffer(envelope.authTag) ||
    envelope.authTag.length !== CREDENTIAL_AUTH_TAG_BYTES ||
    !Number.isInteger(envelope.keyVersion) ||
    envelope.keyVersion < 1
  ) {
    throw new CredentialCryptoError(
      'invalid_envelope',
      'credential envelope must carry non-empty ciphertext, a 12-byte nonce, a 16-byte auth tag, and a positive key version',
    )
  }
}

/**
 * Encrypt plaintext OAuth material with the ring's active key.
 *
 * Nonces are random per call; the returned envelope is exactly what `account_credentials`
 * stores (ciphertext + nonce + tag + key version). Plaintext is never retained or logged.
 */
export function encryptCredential(
  ring: KeyRing,
  context: CredentialContext,
  plaintext: string,
): CredentialEnvelope {
  if (plaintext.length === 0) {
    throw new CredentialCryptoError(
      'empty_plaintext',
      'refusing to encrypt empty credential plaintext',
    )
  }

  const keyVersion = ring.activeVersion
  const key = activeKey(ring)
  const nonce = randomBytes(CREDENTIAL_NONCE_BYTES)

  const cipher = createCipheriv(ALGORITHM, key.subarray(0, KEY_BYTES), nonce, {
    authTagLength: CREDENTIAL_AUTH_TAG_BYTES,
  })
  cipher.setAAD(aad(context, keyVersion))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion }
}

/**
 * Decrypt an envelope with the key version stored on its row (not the active version), so
 * old rows stay readable after key rotation. Any tampering — ciphertext, tag, or the bound
 * account/kind/version context — fails closed with a typed error and no partial plaintext.
 */
export function decryptCredential(
  ring: KeyRing,
  context: CredentialContext,
  envelope: CredentialEnvelope,
): string {
  assertEnvelopeShape(envelope)

  let key: Buffer
  try {
    key = keyForVersion(ring, envelope.keyVersion)
  } catch {
    throw new CredentialCryptoError(
      'unknown_key_version',
      `no encryption key for credential version ${envelope.keyVersion}`,
    )
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key.subarray(0, KEY_BYTES), envelope.nonce, {
      authTagLength: CREDENTIAL_AUTH_TAG_BYTES,
    })
    decipher.setAAD(aad(context, envelope.keyVersion))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new CredentialCryptoError(
      'decryption_failed',
      'credential envelope failed authentication (tampered, wrong row context, or wrong key)',
    )
  }
}
