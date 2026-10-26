import { open } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { APPLICANT_PROFILE_MAX_CHARS, userSettings } from '../db/schema/preferences.js'

/** Use complete first-person facts, one per line; the composer selects whole lines. */
export function profileFacts(profile: string): string[] {
  const text = profile.trim()
  const facts = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (
    !text ||
    text.length > APPLICANT_PROFILE_MAX_CHARS ||
    facts.some(
      (fact) =>
        fact.length > 1_000 || [...fact].some((char) => char.charCodeAt(0) < 32 && char !== '\t'),
    )
  )
    throw new Error(
      'Profile must contain 1–8000 characters, with complete facts of at most 1000 characters per line.',
    )
  return facts
}

export async function setApplicantProfile(db: Db, profile: string): Promise<void> {
  profileFacts(profile)
  const applicantProfile = profile.trim()
  await db
    .insert(userSettings)
    .values({ id: 1, applicantProfile })
    .onConflictDoUpdate({
      target: userSettings.id,
      set: { applicantProfile, updatedAt: new Date() },
    })
}

/** Bound bytes before decoding; file content and parser errors never reach CLI output. */
export async function readProfileFile(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(APPLICANT_PROFILE_MAX_CHARS * 4 + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used === buffer.length) throw new Error('Profile file is too large.')
    const profile = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))
    profileFacts(profile)
    return profile.trim()
  } finally {
    await file.close()
  }
}

export async function getApplicantProfile(db: Db): Promise<string> {
  const [settings] = await db
    .select({ profile: userSettings.applicantProfile })
    .from(userSettings)
    .where(eq(userSettings.id, 1))
    .limit(1)
  if (!settings?.profile)
    throw new Error(
      'Set your applicant profile with pnpm agent:profile set --file <path> before drafting application notes.',
    )
  profileFacts(settings.profile)
  return settings.profile
}
