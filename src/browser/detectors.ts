import type { browserHandoffReason } from '../db/schema/enums.js'
import type { FrameObservation } from './driver.js'
import type { Site } from './sites.js'

export type HandoffReason = (typeof browserHandoffReason.enumValues)[number]

export interface PageObservation {
  url: string
  title: string
  /** URLs of every frame, including iframes (captcha widgets live there). */
  frameUrls: readonly string[]
  /** Missing or unknown presentation remains a potential challenge. */
  frames?: readonly FrameObservation[]
  /** Raw snapshot text; only headings/text are inspected, never acted on. */
  snapshot: string
}

export interface Detection {
  reason: HandoffReason
  /** Bounded, fixed description; never page text. */
  detail: string
}

const RECAPTCHA_FRAME = /^https:\/\/(www\.)?(google\.com|recaptcha\.net)\/recaptcha\//i
const CAPTCHA_FRAMES: { pattern: RegExp; detail: string }[] = [
  {
    pattern: RECAPTCHA_FRAME,
    detail: 'reCAPTCHA challenge',
  },
  { pattern: /^https:\/\/([a-z0-9-]+\.)*hcaptcha\.com\//i, detail: 'hCaptcha challenge' },
  {
    pattern: /^https:\/\/challenges\.cloudflare\.com\//i,
    detail: 'Cloudflare Turnstile challenge',
  },
  {
    pattern: /^https:\/\/([a-z0-9-]+\.)*(arkoselabs\.com|funcaptcha\.com)\//i,
    detail: 'Arkose challenge',
  },
]

/** Only anchor frames can report checkbox completion; image-challenge tiles cannot. */
export function isRecaptchaAnchorUrl(url: string): boolean {
  if (!RECAPTCHA_FRAME.test(url)) return false
  try {
    return /\/recaptcha\/(api2|enterprise)\/anchor\/?$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function isInvisibleRecaptchaAnchor(url: string): boolean {
  return (
    isRecaptchaAnchorUrl(url) &&
    new URL(url).searchParams.get('size')?.toLowerCase() === 'invisible'
  )
}

/**
 * Interstitial and bot-check pages. Includes Reddit's "Prove your humanity" and "You've been
 * blocked by network security" pages, both seen from a logged-out profile on 2026-10-25.
 */
const VERIFICATION_TEXT =
  /\b(prove your humanity|verify you are (a )?human|are you a robot|just a moment|attention required|checking your browser|unusual traffic|press (and|&) hold|security check|blocked by network security|you('|’)ve been blocked)\b/i

/** Challenge markers some sites put in the URL while a JavaScript/bot check runs. */
const CHALLENGE_QUERY_PARAMS = ['js_challenge', '__cf_chl_rt_tk', '__cf_chl_tk']

const TWO_FACTOR_TEXT =
  /\b(two-factor|2fa|two-step verification|authentication code|verification code|enter the (6-digit )?code|one-time (pass)?code|authenticator app)\b/i

const LOGIN_TEXT =
  /\b(log in to continue|sign in to continue|you must be logged in|log in or sign up)\b/i

/** Challenge and block pages are tiny; on larger pages only headings and dialogs count. */
const SMALL_PAGE_LINES = 40

/**
 * Text the detectors inspect: headings, dialogs, and alerts always; body text nodes only on
 * small pages, so a comment that merely mentions "prove your humanity" does not hand off.
 * Each line is cut to 300 characters.
 */
function headingText(snapshot: string): string {
  const lines = snapshot.split('\n')
  const bodyToo = lines.length <= SMALL_PAGE_LINES
  return lines
    .filter(
      (line) =>
        /- (heading|dialog|alertdialog|alert)\b/.test(line) ||
        (bodyToo && /- (text|paragraph|generic)\b/.test(line)),
    )
    .map((line) => line.slice(0, 300))
    .join('\n')
}

/**
 * Recognise pages the agent must hand to the user (D047): captcha widgets, bot checks, 2FA,
 * and login walls. Runs after navigation, after each click, and before approval. The app never
 * tries to solve or bypass these.
 */
export function detectHandoff(site: Site, page: PageObservation): Detection | undefined {
  for (const frameUrl of page.frameUrls) {
    const hit = CAPTCHA_FRAMES.find((family) => family.pattern.test(frameUrl))
    if (!hit || isInvisibleRecaptchaAnchor(frameUrl)) continue
    const observed = page.frames?.filter((frame) => frame.url === frameUrl)
    if (
      observed?.length &&
      observed.every(
        (frame) =>
          frame.visible === false ||
          (frame.visible === true && frame.solved === true && isRecaptchaAnchorUrl(frameUrl)),
      )
    )
      continue
    return { reason: 'captcha', detail: hit.detail }
  }

  let parsedUrl: URL | undefined
  try {
    parsedUrl = new URL(page.url)
  } catch {
    // An unparseable URL carries no challenge or login signal.
  }
  if (parsedUrl && CHALLENGE_QUERY_PARAMS.some((name) => parsedUrl.searchParams.has(name))) {
    return { reason: 'verification', detail: 'bot check or verification page' }
  }

  const text = `${page.title}\n${headingText(page.snapshot)}`
  if (VERIFICATION_TEXT.test(text))
    return { reason: 'verification', detail: 'bot check or verification page' }
  if (TWO_FACTOR_TEXT.test(text))
    return { reason: 'two_factor', detail: 'two-factor code requested' }

  const path = parsedUrl && site.origins.includes(parsedUrl.origin) ? parsedUrl.pathname : ''
  if (site.loginPathPatterns.some((pattern) => pattern.test(path))) {
    return { reason: 'login', detail: 'redirected to the login page' }
  }
  if (LOGIN_TEXT.test(text)) return { reason: 'login', detail: 'login required' }
  return undefined
}
