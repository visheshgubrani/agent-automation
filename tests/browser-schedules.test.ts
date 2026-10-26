import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nextScheduleTimes,
  scheduleCron,
  validateScheduleTemplate,
} from '../src/agent/schedules.js'
import { probeBrowserReachability } from '../src/agent/status.js'

afterEach(() => vi.unstubAllGlobals())

describe('Kolkata cron', () => {
  it('computes previews independently of the host timezone and advances past exact slots', () => {
    expect(
      nextScheduleTimes('0 9 * * *', new Date('2026-10-25T03:29:00Z')).map((date) =>
        date.toISOString(),
      ),
    ).toEqual(['2026-10-25T03:30:00.000Z', '2026-10-26T03:30:00.000Z', '2026-10-27T03:30:00.000Z'])
    expect(nextScheduleTimes('0 9 * * *', new Date('2026-10-25T03:30:00Z'))[0]?.toISOString()).toBe(
      '2026-10-26T03:30:00.000Z',
    )
  })
  it.each([
    '* * * * *',
    '0,30 * * * *',
    '*/59 * * * *',
    '0 0 9 * * *',
    '0 25 * * *',
    '0 9 31 2 *',
    'bad cron',
  ])('rejects invalid or sub-hourly cron %s', (cron) => {
    expect(() => nextScheduleTimes(cron, new Date())).toThrow()
  })
  it('accepts irregular hourly/day ranges without mistaking long gaps for permission for short gaps', () => {
    expect(scheduleCron('5 1,23 * * 1-5', new Date()).fields.minute.values).toEqual([5])
    expect(() => scheduleCron('0,59 1 1 1 *', new Date())).toThrow('one hour')
  })
  it('refuses a pending note for Reddit or a changed site target', () => {
    const targetUrl = 'https://www.reddit.com/r/test/comments/abc/thread/'
    expect(() =>
      validateScheduleTemplate('reddit', 'reddit_comment', {
        version: 1,
        targetUrl,
        fields: [],
        composeNote: true,
      }),
    ).toThrow()
    expect(() =>
      validateScheduleTemplate('wellfound', 'wellfound_apply', {
        version: 1,
        targetUrl,
        fields: [],
        composeNote: true,
      }),
    ).toThrow()
  })
})

describe('bounded browser health probe', () => {
  it('never fetches off-loopback or credential-bearing endpoints and returns no error text', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('PRIVATE-PROBE-ERROR'))
    vi.stubGlobal('fetch', fetcher)
    for (const url of [
      'https://evil.example/',
      'http://user:password@127.0.0.1:9222/',
      'file:///etc/passwd',
    ])
      expect(await probeBrowserReachability(url)).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await probeBrowserReachability('http://127.0.0.1:9222')).toBe(false)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('reads only the status and cancels the response body; redirects are forbidden', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const fetcher = vi.fn().mockResolvedValue({ ok: true, body: { cancel } })
    vi.stubGlobal('fetch', fetcher)
    expect(await probeBrowserReachability('http://127.0.0.1:9222')).toBe(true)
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://127.0.0.1:9222/json/version')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
