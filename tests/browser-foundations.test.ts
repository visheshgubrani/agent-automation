import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BROWSER_TASK_STATUS_REASONS,
  browserSubmitApprovalPayloadV1,
  browserTaskSpecV1,
  isStatusReason,
} from '../src/agent/contracts.js'
import { storeArtifactFile } from '../src/browser/artifacts.js'
import { parseCheckUrl } from '../src/browser/check.js'
import { boundSnapshot } from '../src/browser/snapshot.js'

const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const spec = {
  version: 1,
  targetUrl: 'https://www.reddit.com/r/test/comments/abc/thread/',
  fields: [{ key: 'comment_text', value: 'Exact words', provenance: 'user_verbatim' }],
}

const payload = {
  version: 1,
  taskId: '0b5c7a5e-9d0e-4f6a-8c1b-1f2e3d4c5b6a',
  site: 'reddit',
  action: 'reddit_comment',
  targetUrl: spec.targetUrl,
  pageUrl: spec.targetUrl,
  fields: [
    {
      key: 'comment_text',
      label: 'Comment',
      role: 'textbox',
      name: 'Add a comment',
      value: 'Exact words',
      provenance: 'user_verbatim',
    },
  ],
  submit: { role: 'button', name: 'Comment' },
  screenshot: { artifactId: '2c9f0f7e-1d2a-4b3c-9d8e-7f6a5b4c3d2e', sha256: 'a'.repeat(64) },
  preparedAt: '2026-10-25T10:00:00+05:30',
}

describe('browser task contracts', () => {
  it('accepts a v1 spec and rejects unknown keys, http targets, and duplicate fields', () => {
    expect(browserTaskSpecV1.parse(spec)).toEqual(spec)
    expect(browserTaskSpecV1.safeParse({ ...spec, extra: true }).success).toBe(false)
    expect(browserTaskSpecV1.safeParse({ ...spec, targetUrl: 'http://reddit.com/' }).success).toBe(
      false,
    )
    const field = spec.fields[0]
    expect(browserTaskSpecV1.safeParse({ ...spec, fields: [field, field] }).success).toBe(false)
    expect(
      browserTaskSpecV1.safeParse({
        ...spec,
        fields: [{ ...field, value: 'x'.repeat(3_001) }],
      }).success,
    ).toBe(false)
    expect(
      browserTaskSpecV1.safeParse({ ...spec, fields: [{ ...field, provenance: 'page' }] }).success,
    ).toBe(false)
  })

  it('accepts a v1 submit approval payload and requires its screenshot hash', () => {
    expect(browserSubmitApprovalPayloadV1.parse(payload)).toEqual(payload)
    expect(
      browserSubmitApprovalPayloadV1.safeParse({
        ...payload,
        screenshot: { ...payload.screenshot, sha256: 'A'.repeat(64) },
      }).success,
    ).toBe(false)
    expect(browserSubmitApprovalPayloadV1.safeParse({ ...payload, version: 2 }).success).toBe(false)
  })

  it('keeps status reasons inside the column bound', () => {
    for (const reason of BROWSER_TASK_STATUS_REASONS) {
      expect(reason.length).toBeLessThanOrEqual(64)
      expect(isStatusReason(reason)).toBe(true)
    }
    expect(isStatusReason('something_else')).toBe(false)
  })
})

describe('snapshot bounding', () => {
  it('returns short snapshots unchanged and cuts long ones on a line boundary', () => {
    expect(boundSnapshot('- a\n- b', 100)).toEqual({
      text: '- a\n- b',
      totalChars: 7,
      truncated: false,
    })
    const long = Array.from({ length: 50 }, (_, i) => `- button "b${i}" [ref=e${i}]`).join('\n')
    const bounded = boundSnapshot(long, 100)
    expect(bounded.truncated).toBe(true)
    expect(bounded.totalChars).toBe(long.length)
    expect(bounded.text.length).toBeLessThanOrEqual(100)
    expect(long.startsWith(bounded.text)).toBe(true)
    expect(bounded.text.endsWith(']')).toBe(true)
  })
})

describe('artifact files', () => {
  it('stores content-addressed files with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifacts-'))
    tempDirs.push(root)
    const dir = join(root, 'store')
    const bytes = new TextEncoder().encode('png bytes')

    const first = await storeArtifactFile(dir, bytes, 'png')
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(first.byteSize).toBe(bytes.byteLength)
    expect(first.storagePath).toBe(`${first.sha256.slice(0, 2)}/${first.sha256}.png`)
    expect(await readFile(join(dir, first.storagePath), 'utf8')).toBe('png bytes')
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, first.sha256.slice(0, 2)))).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, first.storagePath))).mode & 0o777).toBe(0o600)

    expect(await storeArtifactFile(dir, bytes, 'png')).toEqual(first)
  })

  it('rejects empty files and unsafe extensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifacts-'))
    tempDirs.push(root)
    await expect(storeArtifactFile(root, new Uint8Array(), 'png')).rejects.toThrow()
    await expect(storeArtifactFile(root, new Uint8Array([1]), '../x')).rejects.toThrow()
  })
})

describe('browser check URL', () => {
  it('accepts http(s) only', () => {
    expect(parseCheckUrl('https://example.com')).toBe('https://example.com/')
    expect(() => parseCheckUrl('file:///etc/passwd')).toThrow()
    expect(() => parseCheckUrl('javascript:alert(1)')).toThrow()
  })
})
