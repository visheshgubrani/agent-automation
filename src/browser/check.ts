import { chromium } from 'playwright-core'
import { storeArtifactFile } from './artifacts.js'
import { type BoundedSnapshot, boundSnapshot } from './snapshot.js'

/** Local page used when no URL is given, so the default check makes no network request. */
const CHECK_PAGE = `<!doctype html><title>browser check</title>
<main><h1>Browser check</h1><label>Search <input type="search" name="q"></label>
<button type="button">Open</button></main>`

export interface BrowserCheckOptions {
  cdpUrl: string
  /** http(s) page to snapshot; omitted uses a local page and no network. */
  url?: string
  artifactDir?: string
  maxSnapshotChars?: number
  timeoutMs?: number
}

export interface BrowserCheckResult {
  browserVersion: string
  /** Whether a pre-existing context (the persistent profile) was reused. */
  reusedContext: boolean
  pageUrl: string
  snapshot: BoundedSnapshot
  /** Snapshot refs such as `e2` resolved back to an element via `page.getByRef`. */
  refResolved: boolean
  screenshot: { byteSize: number; sha256?: string; storagePath?: string }
}

export function parseCheckUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('--snapshot URL must use http or https')
  }
  return url.toString()
}

/**
 * Connect over loopback CDP, open one new page, take a bounded AI-mode aria snapshot and a
 * screenshot, close only that page, and disconnect. The browser and its profile stay running.
 */
export async function runBrowserCheck(options: BrowserCheckOptions): Promise<BrowserCheckResult> {
  const timeout = options.timeoutMs ?? 30_000
  const browser = await chromium.connectOverCDP(options.cdpUrl, { timeout })
  try {
    const [existing] = browser.contexts()
    const context = existing ?? (await browser.newContext())
    const page = await context.newPage()
    try {
      if (options.url) {
        await page.goto(options.url, { timeout, waitUntil: 'domcontentloaded' })
      } else {
        await page.setContent(CHECK_PAGE, { timeout })
      }

      const raw = await page.ariaSnapshot({ mode: 'ai', timeout })
      const snapshot = boundSnapshot(raw, options.maxSnapshotChars)
      const firstRef = /\[ref=([a-z0-9]+)\]/i.exec(raw)?.[1]
      const refResolved = firstRef !== undefined && (await page.getByRef(firstRef).count()) === 1

      const bytes = await page.screenshot({ type: 'png', timeout })
      const screenshot = options.artifactDir
        ? await storeArtifactFile(options.artifactDir, bytes, 'png')
        : { byteSize: bytes.byteLength }

      return {
        browserVersion: browser.version(),
        reusedContext: existing !== undefined,
        pageUrl: page.url(),
        snapshot,
        refResolved,
        screenshot,
      }
    } finally {
      await page.close().catch(() => undefined)
    }
  } finally {
    // For a CDP connection this disconnects; it never quits the shared browser.
    await browser.close()
  }
}
