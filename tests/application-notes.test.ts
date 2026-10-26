import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizeApplicationUrl, validateIntakeOutput } from '../src/agent/intake.js'
import { noteFromSelection } from '../src/agent/notes.js'
import { profileFacts, readProfileFile } from '../src/agent/profile.js'
import { applicationStatus } from '../src/browser/applications.js'
import { assertClickAllowed, isActionTargetPage } from '../src/browser/guards.js'
import { getSiteAction } from '../src/browser/sites.js'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})
const PROFILE = 'I build TypeScript services.\nI do not have production Rust experience.'
const APPLICATION_SITES = [
  {
    site: 'waas',
    action: 'waas_apply',
    url: 'https://www.workatastartup.com/jobs/12345',
    send: 'Send',
  },
  {
    site: 'wellfound',
    action: 'wellfound_apply',
    url: 'https://wellfound.com/jobs/12345-engineer',
    send: 'Send Application',
  },
]

describe('profile-backed note composition', () => {
  it('keeps complete source facts, negations and profile order, and cannot add arbitrary claims or targets', () => {
    const note = noteFromSelection(PROFILE, { factIndexes: [1, 0] })
    expect(note).toContain(PROFILE)
    for (const output of [
      { factIndexes: [2] },
      { factIndexes: [0, 0] },
      { factIndexes: [] },
      { factIndexes: [0.5] },
      {
        factIndexes: [0],
        note: 'I have ten years of Rust experience.',
        targetUrl: 'https://evil.example',
      },
    ])
      expect(() => noteFromSelection(PROFILE, output)).toThrow()
    expect(() =>
      noteFromSelection(Array.from({ length: 3 }, () => 'a'.repeat(900)).join('\n'), {
        factIndexes: [0, 1, 2],
      }),
    ).toThrow('too long')
  })
  it('bounds UTF-8 file reads and rejects blank, invalid, long and control-character profiles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'profile-'))
    dirs.push(dir)
    const file = join(dir, 'profile.txt')
    await writeFile(file, PROFILE)
    expect(await readProfileFile(file)).toBe(PROFILE)
    await writeFile(file, Buffer.from([0xff]))
    await expect(readProfileFile(file)).rejects.toThrow()
    await writeFile(file, 'a'.repeat(32_001))
    await expect(readProfileFile(file)).rejects.toThrow('too large')
    for (const profile of [
      ' ',
      'x'.repeat(1_001),
      Array.from({ length: 9 }, () => 'x'.repeat(1_000)).join('\n'),
      'a\0b',
    ])
      expect(() => profileFacts(profile)).toThrow()
  })
})

describe.each(APPLICATION_SITES)('$site application boundaries', ({ site, action, url, send }) => {
  const found = getSiteAction(site, action)
  if (!found) throw new Error('missing application registry entry')
  const output = {
    kind: 'one_off',
    site,
    action,
    targetUrl: url,
    fields: [],
    cron: null,
    question: null,
  }
  it('pins an explicit job and defers all generated claims to the profile composer', () => {
    const plan = validateIntakeOutput(output, `Apply to ${url} with a short note from my profile.`)
    expect(plan).toMatchObject({
      kind: 'one_off',
      site,
      action,
      spec: { targetUrl: url, fields: [], composeNote: true },
    })
    expect(
      validateIntakeOutput(
        {
          ...output,
          fields: [{ key: 'application_note', value: 'Invented claims', provenance: 'drafted' }],
        },
        `Apply to ${url}`,
      ),
    ).toMatchObject({ spec: { fields: [], composeNote: true } })
    expect(validateIntakeOutput(output, 'Apply to a suitable job.').kind).toBe('unclear')
    expect(
      validateIntakeOutput(
        { ...output, targetUrl: url.replace('12345', '99999') },
        `Apply to ${url}`,
      ).kind,
    ).toBe('unclear')
    expect(
      normalizeApplicationUrl(site, url.replace('https://', 'https://user:password@')),
    ).toBeUndefined()
    expect(normalizeApplicationUrl(site, `${url}/apply`)).toBeUndefined()
    expect(normalizeApplicationUrl(site, `${url}?tracking=123#section`)).toBe(url)
  })
  it('preserves explicit user text and rejects a paraphrase labelled verbatim', () => {
    const fields = [
      { key: 'application_note', value: 'My exact note.', provenance: 'user_verbatim' },
    ]
    expect(
      validateIntakeOutput({ ...output, fields }, `Apply to ${url}\nMy exact note.`),
    ).toMatchObject({ spec: { fields } })
    expect(
      validateIntakeOutput({ ...output, fields }, `Apply to ${url}\nDifferent words.`).kind,
    ).toBe('unclear')
  })
  it('permits the registered opener and refuses commit controls and other state changes', () => {
    const element = (name: string) => ({ ref: 'e1', role: 'button', name, flags: [] })
    expect(() => assertClickAllowed(found.site, found.action, element('Apply'), url)).not.toThrow()
    for (const name of [send, 'Submit', 'Delete', 'Confirm', 'Apply and send'])
      expect(() => assertClickAllowed(found.site, found.action, element(name), url)).toThrow()
    expect(isActionTargetPage(found.action, url, `${url}/apply`)).toBe(true)
    expect(isActionTargetPage(found.action, url, url.replace('12345', '99999'))).toBe(false)
    expect(isActionTargetPage(found.action, url, url.replace('/jobs/', '/company/'))).toBe(false)
    expect(isActionTargetPage(found.action, url, url.replace('https://', 'https://evil.'))).toBe(
      false,
    )
  })
  it('recognizes exact applied statuses and ignores job prose quoting a success phrase', () => {
    expect(applicationStatus(found.action, '- button "Applied" [ref=e1]', 'alreadyApplied')).toBe(
      true,
    )
    expect(applicationStatus(found.action, '- status "Application sent" [ref=e1]', 'success')).toBe(
      true,
    )
    expect(
      applicationStatus(found.action, '- paragraph [ref=e1]: Application sent', 'success'),
    ).toBe(false)
    expect(
      applicationStatus(found.action, '- heading "Not applied" [ref=e1]', 'alreadyApplied'),
    ).toBe(false)
  })
})
