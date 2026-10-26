import { type Browser, chromium, type Frame, type Page } from 'playwright-core'
import { isRecaptchaAnchorUrl } from './detectors.js'
import type {
  BrowserDriver,
  BrowserPage,
  BrowserSession,
  FrameObservation,
  ScrollDirection,
} from './driver.js'
import {
  REDDIT_POST_BODY_MAX_CHARS,
  REDDIT_POST_TITLE_MAX_CHARS,
  type RedditPostContent,
  redditThreadId,
} from './reddit.js'

export interface PlaywrightDriverOptions {
  /** Loopback CDP endpoint (validated by config). */
  cdpUrl: string
  /** Per-action timeout. */
  actionTimeoutMs?: number
  navigationTimeoutMs?: number
}

const SCROLL_PIXELS = 600
const MAX_OBSERVED_FRAMES = 64

export class PlaywrightPage implements BrowserPage {
  constructor(
    private readonly page: Page,
    private readonly timeouts: { action: number; navigation: number },
  ) {}

  async targetId(): Promise<string | undefined> {
    try {
      const session = await this.page.context().newCDPSession(this.page)
      try {
        const info = (await session.send('Target.getTargetInfo')) as {
          targetInfo?: { targetId?: string }
        }
        return info.targetInfo?.targetId
      } finally {
        await session.detach().catch(() => undefined)
      }
    } catch {
      return undefined
    }
  }

  url(): string {
    return this.page.url()
  }

  title(): Promise<string> {
    return this.page.title()
  }

  frameUrls(): string[] {
    return this.page.frames().map((frame) => frame.url())
  }

  async frameObservations(): Promise<FrameObservation[]> {
    const visibility = new Map<Frame, Promise<boolean | null>>()
    const presented = (frame: Frame): Promise<boolean | null> => {
      const cached = visibility.get(frame)
      if (cached) return cached
      const check = (async (): Promise<boolean | null> => {
        const parent = frame.parentFrame()
        if (!parent) return true
        const element = await frame.frameElement()
        try {
          // Driver-internal presentation read. No page text or input values are inspected.
          const local = await element.evaluate((node) => {
            if (!(node instanceof Element)) throw new Error('frame element unavailable')
            const box = node.getBoundingClientRect()
            if (box.width <= 1 || box.height <= 1) return false
            let current: Element | null = node
            while (current) {
              const style = getComputedStyle(current)
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse' ||
                Number(style.opacity) === 0 ||
                style.contentVisibility === 'hidden'
              )
                return false
              const root = current.getRootNode()
              current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
            }
            return true
          })
          return local ? await presented(parent) : false
        } finally {
          await element.dispose()
        }
      })().catch(() => null)
      visibility.set(frame, check)
      return check
    }
    const frames = this.page
      .frames()
      .filter((frame) => frame.parentFrame())
      .slice(0, MAX_OBSERVED_FRAMES)
    const observations = Promise.all(
      frames.map(async (frame): Promise<FrameObservation> => {
        const url = frame.url()
        const visible = await presented(frame)
        try {
          // Read only the checkbox's public completion state, never a response token.
          const solved =
            visible === true &&
            isRecaptchaAnchorUrl(url) &&
            (await frame
              .locator('#recaptcha-anchor[role="checkbox"][aria-checked="true"]')
              .count()) > 0
          return { url, visible, ...(solved ? { solved: true } : {}) }
        } catch {
          return { url, visible: null }
        }
      }),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        observations,
        new Promise<FrameObservation[]>((resolve) => {
          timer = setTimeout(
            () => resolve(frames.map((frame) => ({ url: frame.url(), visible: null }))),
            this.timeouts.action,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { timeout: this.timeouts.navigation, waitUntil: 'domcontentloaded' })
  }

  async goBack(): Promise<void> {
    await this.page.goBack({ timeout: this.timeouts.navigation, waitUntil: 'domcontentloaded' })
  }

  ariaSnapshot(): Promise<string> {
    return this.page.ariaSnapshot({ mode: 'ai', timeout: this.timeouts.action })
  }

  async readRedditPost(targetUrl: string): Promise<RedditPostContent> {
    const id = redditThreadId(targetUrl)
    const unavailable: RedditPostContent = {
      title: '',
      body: '',
      truncated: false,
      unavailable: true,
      media: false,
    }
    if (!id || redditThreadId(this.page.url()) !== id) return unavailable
    const post = this.page.locator(`shreddit-post[id="t3_${id}"]`)
    try {
      await post.waitFor({ state: 'attached', timeout: this.timeouts.action })
    } catch {
      return unavailable
    }
    if ((await post.count()) !== 1) return unavailable
    return post.evaluate(
      (node, limits) => {
        const title = (
          node.querySelector('[slot="title"]')?.textContent ??
          node.getAttribute('post-title') ??
          ''
        ).trim()
        const body =
          (node.querySelector('[slot="text-body"]') as HTMLElement | null)?.innerText?.trim() ?? ''
        return {
          title: title.slice(0, limits.title),
          body: body.slice(0, limits.body),
          truncated: title.length > limits.title || body.length > limits.body,
          unavailable: !title || /^(\[removed\]|\[deleted\])$/i.test(body),
          media: ['image', 'video', 'gallery', 'multi_media'].includes(
            node.getAttribute('post-type') ?? '',
          ),
        }
      },
      { title: REDDIT_POST_TITLE_MAX_CHARS, body: REDDIT_POST_BODY_MAX_CHARS },
      { timeout: this.timeouts.action },
    )
  }

  async isRedditCommentComposer(ref: string, targetUrl: string): Promise<boolean> {
    const id = redditThreadId(targetUrl)
    if (!id || redditThreadId(this.page.url()) !== id) return false
    return this.page.getByRef(ref).evaluate(
      (element, expected) => {
        let current: Element | null = element
        let composer = false
        let owned = false
        while (current) {
          if (current.tagName.toLowerCase() === 'shreddit-comment') return false
          if (current.tagName.toLowerCase() === 'comment-composer-host') composer = true
          for (const name of ['parent-id', 'thing-id', 'post-id']) {
            const value = current.getAttribute(name)
            if (value?.startsWith('t1_')) return false
            if (value?.startsWith('t3_')) {
              if (value !== expected) return false
              owned = true
            }
          }
          const root = current.getRootNode()
          current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
        }
        return composer && owned
      },
      `t3_${id}`,
      { timeout: this.timeouts.action },
    )
  }

  async click(ref: string): Promise<void> {
    await this.page.getByRef(ref).click({ timeout: this.timeouts.action })
  }

  async fill(ref: string, value: string): Promise<void> {
    await this.page.getByRef(ref).fill(value, { timeout: this.timeouts.action })
  }

  readValue(ref: string): Promise<string> {
    // Driver-internal read-back (D042); the model has no JavaScript tool.
    return this.page.getByRef(ref).evaluate(
      (element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
          return element.value
        return (element as HTMLElement).isContentEditable
          ? (element as HTMLElement).innerText
          : (element.textContent ?? '')
      },
      undefined,
      { timeout: this.timeouts.action },
    )
  }

  isEnabled(ref: string): Promise<boolean> {
    return this.page.getByRef(ref).isEnabled({ timeout: this.timeouts.action })
  }

  async press(key: string, ref?: string): Promise<void> {
    if (ref !== undefined)
      await this.page.getByRef(ref).press(key, { timeout: this.timeouts.action })
    else await this.page.keyboard.press(key)
  }

  async scroll(direction: ScrollDirection): Promise<void> {
    await this.page.mouse.wheel(0, direction === 'down' ? SCROLL_PIXELS : -SCROLL_PIXELS)
  }

  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms)
  }

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot({ type: 'png', timeout: this.timeouts.action })
  }
}

/**
 * Production driver: `connectOverCDP` per task, one new page in the persistent profile's
 * default context, and disconnect at the end. The shared browser is never closed (D041).
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  constructor(private readonly options: PlaywrightDriverOptions) {}

  async openSession(): Promise<BrowserSession> {
    const navigation = this.options.navigationTimeoutMs ?? 30_000
    const action = this.options.actionTimeoutMs ?? 10_000
    const browser: Browser = await chromium.connectOverCDP(this.options.cdpUrl, {
      timeout: navigation,
    })
    try {
      const [existing] = browser.contexts()
      const context = existing ?? (await browser.newContext())
      const page = await context.newPage()
      return {
        page: new PlaywrightPage(page, { action, navigation }),
        disconnect: async () => {
          await page.close().catch(() => undefined)
          // For a CDP connection this only disconnects.
          await browser.close()
        },
      }
    } catch (error) {
      await browser.close().catch(() => undefined)
      throw error
    }
  }
}
