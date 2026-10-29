import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserSession } from '../src/browser/driver.js'
import { PlaywrightBrowserDriver } from '../src/browser/playwright-driver.js'
import { parseSnapshotElements, StaleRefError } from '../src/browser/snapshot.js'

/**
 * Optional real-Chromium checks against fixture HTML. Run with the browser container up:
 *   BROWSER_TEST_CDP_URL=http://127.0.0.1:9222 pnpm exec vitest run tests/browser-playwright.test.ts
 * The fixture server listens on BROWSER_TEST_FIXTURE_BIND (default 0.0.0.0) only while the test
 * runs; Chromium in the container reaches it as BROWSER_TEST_FIXTURE_HOST (host.docker.internal).
 */
const cdpUrl = process.env.BROWSER_TEST_CDP_URL
const fixtureBind = process.env.BROWSER_TEST_FIXTURE_BIND ?? '0.0.0.0'
const fixtureHost = process.env.BROWSER_TEST_FIXTURE_HOST ?? 'host.docker.internal'

const PAGES: Record<string, string> = {
  '/form': `<!doctype html><title>Fixture form</title><main>
    <h1>Fixture thread</h1>
    <label>Comment <textarea name="c"></textarea></label>
    <div role="textbox" aria-label="Rich comment" contenteditable="true"></div>
    <label>Search <input type="search" name="q"></label>
    <button type="button" disabled>Comment</button>
    <button type="button" id="open" onclick="document.getElementById('more').hidden=false">Open composer</button>
    <p id="more" hidden>Composer opened</p>
    <iframe title="widget" src="/frame"></iframe>
  </main>`,
  '/frame': '<!doctype html><title>frame</title><p>inner</p>',
  '/rerender': `<!doctype html><title>Rerender</title><main>
    <button type="button" id="stale">Placeholder</button>
    <button type="button" onclick="document.getElementById('stale').hidden=true">Hydrate</button>
  </main>`,
  '/visibility': `<!doctype html><title>Frame visibility</title><main>
    <iframe title="visible" src="/frame?visible"></iframe>
    <iframe title="hidden" style="display:none" src="/frame?hidden"></iframe>
    <div style="opacity:0"><iframe title="transparent" src="/frame?transparent"></iframe></div>
    <iframe title="tracking" style="width:1px;height:1px;border:0" src="/frame?tiny"></iframe>
    <iframe title="hidden parent" style="visibility:hidden" src="/nested"></iframe>
    <button type="button" id="show" onclick="document.querySelector('[title=hidden]').style.display='block'">Show frame</button>
  </main>`,
  '/nested': '<!doctype html><iframe title="nested child" src="/frame?nested"></iframe>',
}

describe.skipIf(!cdpUrl)('Playwright driver against real Chromium', () => {
  let server: Server
  let base = ''
  let session: BrowserSession

  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = PAGES[(req.url ?? '').split('?')[0] ?? '']
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body ?? 'not found')
    })
    await new Promise<void>((resolve) => server.listen(0, fixtureBind, resolve))
    base = `http://${fixtureHost}:${(server.address() as AddressInfo).port}`
    session = await new PlaywrightBrowserDriver({ cdpUrl: cdpUrl ?? '' }).openSession()
  })

  afterAll(async () => {
    await session?.disconnect()
    // Chromium keeps fixture connections alive; drop them so close() returns.
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  })

  it('snapshots with refs, fills, reads back, clicks, and screenshots', async () => {
    const { page } = session
    await page.goto(`${base}/form`)
    expect(await page.title()).toBe('Fixture form')
    expect(page.frameUrls().some((url) => url.endsWith('/frame'))).toBe(true)
    expect(await page.targetId()).toMatch(/^[A-F0-9]+$/i)

    const elements = [...parseSnapshotElements(await page.ariaSnapshot()).values()]
    const find = (role: string, name: string) => {
      const element = elements.find((e) => e.role === role && e.name === name)
      if (!element) throw new Error(`no ${role} "${name}" in snapshot`)
      return element
    }

    const textarea = find('textbox', 'Comment')
    const text = 'Exact words, with "quotes" and an emoji 🙂\nsecond line'
    await page.fill(textarea.ref, text)
    expect(await page.readValue(textarea.ref)).toBe(text)

    const rich = find('textbox', 'Rich comment')
    await page.fill(rich.ref, 'rich text')
    expect(await page.readValue(rich.ref)).toBe('rich text')

    const commit = find('button', 'Comment')
    expect(commit.flags).toContain('disabled')
    expect(await page.isEnabled(commit.ref)).toBe(false)

    await page.click(find('button', 'Open composer').ref)
    const after = [...parseSnapshotElements(await page.ariaSnapshot()).values()]
    expect(after.some((e) => e.name === 'Composer opened' || e.role === 'paragraph')).toBe(true)

    await page.press('Tab')
    await page.scroll('down')
    const png = await page.screenshot()
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('observes rendered, hidden, transparent, tiny and nested frames without reading their bodies', async () => {
    const { page } = session
    await page.goto(`${base}/visibility`)
    // Frame DOMs can finish loading after the top document's DOMContentLoaded.
    let frames = await page.frameObservations()
    for (let n = 0; n < 20 && !frames.some((frame) => frame.url.endsWith('?nested')); n++) {
      await page.wait(50)
      frames = await page.frameObservations()
    }
    const visible = (suffix: string) => frames.find((frame) => frame.url.endsWith(suffix))?.visible
    expect(visible('?visible')).toBe(true)
    for (const suffix of ['?hidden', '?transparent', '?tiny', '/nested', '?nested'])
      expect(visible(suffix)).toBe(false)
    expect(
      frames.every((frame) =>
        Object.keys(frame).every((key) => ['url', 'visible', 'solved'].includes(key)),
      ),
    ).toBe(true)
    const elements = [...parseSnapshotElements(await page.ariaSnapshot()).values()]
    const show = elements.find(
      (element) => element.role === 'button' && element.name === 'Show frame',
    )
    if (!show) throw new Error('missing fixture button')
    await page.click(show.ref)
    expect(
      (await page.frameObservations()).find((frame) => frame.url.endsWith('?hidden'))?.visible,
    ).toBe(true)
  })

  it('fails fast with a stale-ref error when a snapshot element was hidden by a re-render', async () => {
    const { page } = session
    await page.goto(`${base}/rerender`)
    const elements = [...parseSnapshotElements(await page.ariaSnapshot()).values()]
    const ref = (name: string) => {
      const element = elements.find((e) => e.role === 'button' && e.name === name)
      if (!element) throw new Error(`missing fixture button ${name}`)
      return element.ref
    }
    await page.click(ref('Hydrate'))
    const started = performance.now()
    await expect(page.click(ref('Placeholder'))).rejects.toBeInstanceOf(StaleRefError)
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})
