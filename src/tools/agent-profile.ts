import { parseArgs } from 'node:util'
import { readProfileFile, setApplicantProfile } from '../agent/profile.js'
import { db, pool } from '../db/index.js'

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { file: { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length !== 1 || positionals[0] !== 'set' || !values.file) {
    throw new Error('invalid arguments')
  }
  const profile = await readProfileFile(values.file)
  await setApplicantProfile(db, profile)
  console.log(`Applicant profile saved (${profile.length} characters).`)
}

main()
  .catch(() => {
    console.error(
      'Could not save applicant profile. Use: pnpm agent:profile set --file <UTF-8 file>. Limit: 8000 characters; complete first-person facts, one per line, at most 1000 characters per line. Check file access and database configuration.',
    )
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
