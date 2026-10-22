/** AES-256-GCM keys are exactly 32 bytes. */
export const ENCRYPTION_KEY_BYTES = 32

/** `account_credentials.key_version` is a smallint and must be positive. */
export const MAX_KEY_VERSION = 32767

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

export interface KeyRing {
  /** Parsed keys by version. Values are raw 32-byte AES keys. */
  readonly keys: ReadonlyMap<number, Buffer>
  /** Key version used for new encryption. Old versions stay readable. */
  readonly activeVersion: number
}

function parseVersion(text: string): number {
  if (!/^\d+$/.test(text)) {
    throw new Error(`key version "${text}" is not a positive integer`)
  }
  const version = Number(text)
  if (!Number.isInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
    throw new Error(`key version ${text} must be between 1 and ${MAX_KEY_VERSION}`)
  }
  return version
}

/**
 * Parse `version:base64key[,version:base64key...]`.
 *
 * The format is intentionally explicit: the version is stored with ciphertext so old keys can stay
 * in the ring until credentials are re-encrypted. Errors name the offending version, never the key.
 */
export function parseKeyRing(raw: string, activeVersion: number): KeyRing {
  if (!Number.isInteger(activeVersion) || activeVersion < 1 || activeVersion > MAX_KEY_VERSION) {
    throw new Error(`active key version must be between 1 and ${MAX_KEY_VERSION}`)
  }

  const entries = raw.split(',').map((entry) => entry.trim())
  if (entries.length === 0 || entries.some((entry) => entry === '')) {
    throw new Error('expected a comma-separated list of version:base64key entries')
  }

  const keys = new Map<number, Buffer>()
  for (const entry of entries) {
    const separator = entry.indexOf(':')
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error('each key entry must be version:base64key')
    }

    const version = parseVersion(entry.slice(0, separator).trim())
    if (keys.has(version)) {
      throw new Error(`duplicate key version ${version}`)
    }

    const encoded = entry.slice(separator + 1).trim()
    if (!BASE64_PATTERN.test(encoded)) {
      throw new Error(`key version ${version} is not valid base64`)
    }

    const key = Buffer.from(encoded, 'base64')
    if (key.length !== ENCRYPTION_KEY_BYTES) {
      throw new Error(
        `key version ${version} must decode to ${ENCRYPTION_KEY_BYTES} bytes (got ${key.length})`,
      )
    }

    keys.set(version, key)
  }

  if (!keys.has(activeVersion)) {
    const available = [...keys.keys()].join(', ')
    throw new Error(`active key version ${activeVersion} is not present (have ${available})`)
  }

  return { keys, activeVersion }
}

export function activeKey(ring: KeyRing): Buffer {
  const key = ring.keys.get(ring.activeVersion)
  if (!key) {
    throw new Error(`active key version ${ring.activeVersion} is not present`)
  }
  return key
}

export function keyForVersion(ring: KeyRing, version: number): Buffer {
  const key = ring.keys.get(version)
  if (!key) {
    throw new Error(`no encryption key for version ${version}`)
  }
  return key
}
