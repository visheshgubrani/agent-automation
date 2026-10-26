import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Db, DbSession } from '../db/index.js'
import { type ArtifactRow, artifacts } from '../db/schema/index.js'
import type { OutboxPhoto } from '../notifications/outbox.js'

export interface StoredArtifactFile {
  sha256: string
  byteSize: number
  /** Relative to the artifact directory, as stored in `artifacts.storage_path`. */
  storagePath: string
}

const EXTENSION = /^[a-z0-9]{1,8}$/

/**
 * Write bytes content-addressed by sha256 (`<aa>/<sha256>.<ext>`) under `artifactDir`. The
 * directories are mode 0700 and files 0600: screenshots can show private pages. Writing the
 * same bytes twice is a no-op rename onto identical content.
 */
export async function storeArtifactFile(
  artifactDir: string,
  bytes: Uint8Array,
  extension: string,
): Promise<StoredArtifactFile> {
  if (bytes.byteLength === 0) throw new Error('refusing to store an empty artifact')
  if (!EXTENSION.test(extension)) throw new Error('invalid artifact extension')

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const storagePath = join(sha256.slice(0, 2), `${sha256}.${extension}`)
  const directory = join(artifactDir, sha256.slice(0, 2))

  await mkdir(artifactDir, { recursive: true, mode: 0o700 })
  await chmod(artifactDir, 0o700)
  await mkdir(directory, { recursive: true, mode: 0o700 })

  const finalPath = join(artifactDir, storagePath)
  const tempPath = `${finalPath}.${process.pid}.tmp`
  await writeFile(tempPath, bytes, { mode: 0o600 })
  await rename(tempPath, finalPath)

  return { sha256, byteSize: bytes.byteLength, storagePath }
}

/**
 * Store a PNG screenshot on disk and record its `artifacts` row. Identical bytes reuse the
 * existing row (unique kind + sha256); the first task to store them keeps the task link.
 */
export async function recordScreenshot(
  db: Db,
  options: { artifactDir: string; bytes: Uint8Array; taskId?: string },
): Promise<ArtifactRow> {
  const sha256 = createHash('sha256').update(options.bytes).digest('hex')
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`artifact:${sha256}`}, 0))`,
    )
    const file = await storeArtifactFile(options.artifactDir, options.bytes, 'png')
    const [row] = await tx
      .insert(artifacts)
      .values({
        kind: 'screenshot',
        sha256,
        mime: 'image/png',
        byteSize: file.byteSize,
        storagePath: file.storagePath,
        ...(options.taskId ? { taskId: options.taskId } : {}),
      })
      .onConflictDoUpdate({
        target: [artifacts.kind, artifacts.sha256],
        set: { deletedAt: null, createdAt: new Date(), storagePath: file.storagePath },
      })
      .returning()
    if (!row) throw new Error('Screenshot artifact could not be recorded.')
    return row
  })
}

export const ARTIFACT_RETENTION_MS = 14 * 24 * 60 * 60_000

/** Delete first, then tombstone. Other filesystem failures remain retryable on the next sweep. */
export async function retainArtifacts(
  db: Db,
  artifactDir: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<{ deleted: number; failed: number }> {
  const cutoff = new Date(now.getTime() - ARTIFACT_RETENTION_MS)
  const candidates = await db
    .select({ id: artifacts.id, sha256: artifacts.sha256 })
    .from(artifacts)
    .where(and(isNull(artifacts.deletedAt), lt(artifacts.createdAt, cutoff)))
    .orderBy(artifacts.createdAt)
  let deleted = 0
  let failed = 0
  for (const candidate of candidates) {
    if (signal?.aborted) break
    try {
      const removed = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`artifact:${candidate.sha256}`}, 0))`,
        )
        const [row] = await tx
          .select()
          .from(artifacts)
          .where(
            and(
              eq(artifacts.id, candidate.id),
              isNull(artifacts.deletedAt),
              lt(artifacts.createdAt, cutoff),
            ),
          )
          .for('update')
          .limit(1)
        if (!row) return false
        const path = resolve(artifactDir, row.storagePath)
        const rel = relative(artifactDir, path)
        if (!rel || rel.startsWith('..') || isAbsolute(rel))
          throw new Error('Unsafe artifact path.')
        try {
          await unlink(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await tx.update(artifacts).set({ deletedAt: now }).where(eq(artifacts.id, row.id))
        return true
      })
      if (removed) deleted++
    } catch {
      failed++
    }
  }
  return { deleted, failed }
}

/**
 * The photo reference for an artifact id, when the row exists and has not been tombstoned.
 * Used for result/handoff cards that point back at a stored screenshot.
 */
export async function artifactPhotoRef(
  db: DbSession,
  artifactId: string,
): Promise<OutboxPhoto | undefined> {
  const [row] = await db
    .select({ id: artifacts.id, sha256: artifacts.sha256 })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.kind, 'screenshot'),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(1)
  return row ? { artifactId: row.id, sha256: row.sha256 } : undefined
}

/**
 * Load a stored screenshot for Telegram delivery (D045). Returns undefined when the row is
 * missing or tombstoned, the hash does not match the payload, the path escapes the artifact
 * directory, or the file cannot be read; the dispatcher then falls back to text.
 */
export async function loadArtifactPhoto(
  db: Db,
  artifactDir: string,
  photo: OutboxPhoto,
): Promise<Uint8Array | undefined> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, photo.artifactId),
        eq(artifacts.kind, 'screenshot'),
        eq(artifacts.sha256, photo.sha256),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(1)
  if (!row) return undefined

  const path = resolve(artifactDir, row.storagePath)
  const rel = relative(artifactDir, path)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined

  try {
    const bytes = await readFile(path)
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) return undefined
    return new Uint8Array(bytes)
  } catch {
    return undefined
  }
}
