import type { RedditPostContent } from './reddit.js'

/**
 * The browser seam (phase 05). Tools and the executor depend only on these interfaces, so
 * tests use `FakeBrowserDriver` and production uses `PlaywrightBrowserDriver` over loopback CDP.
 * Refs are Playwright AI-mode snapshot refs (`e12`); generation checks happen above this layer.
 */
export interface BrowserDriver {
  /** Connect and open one new page in the persistent profile. */
  openSession(): Promise<BrowserSession>
}

export interface BrowserSession {
  page: BrowserPage
  /** Close nothing but this session's page, then disconnect. Never quits the browser. */
  disconnect(): Promise<void>
}

export type ScrollDirection = 'up' | 'down'

/** Presentation metadata only; never frame bodies, field values, or CAPTCHA tokens. */
export interface FrameObservation {
  url: string
  /** Null means presentation could not be inspected; detectors remain conservative. */
  visible: boolean | null
  /** A known reCAPTCHA anchor checkbox reports completion through aria-checked. */
  solved?: boolean
}

export interface BrowserPage {
  /** CDP target id, recorded on the task so a takeover can find the tab. */
  targetId(): Promise<string | undefined>
  url(): string
  title(): Promise<string>
  /** URLs of every frame, main frame first. */
  frameUrls(): string[]
  frameObservations(): Promise<FrameObservation[]>
  goto(url: string): Promise<void>
  goBack(): Promise<void>
  /** AI-mode aria snapshot (`[ref=eN]` markers). */
  ariaSnapshot(): Promise<string>
  /** Bounded primary-post content only; never neighbouring posts, comments or inputs. */
  readRedditPost(targetUrl: string): Promise<RedditPostContent>
  /** A field/control belongs to the requested post's top-level comment composer. */
  isRedditCommentComposer(ref: string, targetUrl: string): Promise<boolean>
  click(ref: string): Promise<void>
  /** Replace the element's content with `value`. */
  fill(ref: string, value: string): Promise<void>
  /** Current value of an input or the text of a contenteditable editor. */
  readValue(ref: string): Promise<string>
  isEnabled(ref: string): Promise<boolean>
  /** Press one key, focusing `ref` first when given. */
  press(key: string, ref?: string): Promise<void>
  scroll(direction: ScrollDirection): Promise<void>
  wait(ms: number): Promise<void>
  screenshot(): Promise<Uint8Array>
}
