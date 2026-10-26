import type { BrowserTaskSpecV1 } from '../agent/contracts.js'
import { redditThreadId } from './reddit.js'
import type { ElementMatcher, Site, SiteAction } from './sites.js'
import type { SnapshotElement } from './snapshot.js'

/** A deterministic refusal by the tool layer; the model sees the message and may try again. */
export class GuardError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GuardError'
    this.code = code
  }
}

export function isAllowedOrigin(site: Site, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    !parsed.username &&
    !parsed.password &&
    site.origins.includes(parsed.origin)
  )
}

export function assertAllowedOrigin(site: Site, url: string): void {
  if (!isAllowedOrigin(site, url)) {
    throw new GuardError(
      'origin_not_allowed',
      `${site.label} tasks may only visit ${site.origins.join(', ')}`,
    )
  }
}

/** A text post must be prepared in the requested community, including after human takeover. */
export function isActionTargetPage(
  action: SiteAction,
  targetUrl: string,
  pageUrl: string,
): boolean {
  if (action.key === 'reddit_comment') {
    const expected = redditThreadId(targetUrl)
    return expected !== undefined && redditThreadId(pageUrl) === expected
  }
  if (action.key !== 'reddit_post' && !action.application) return true
  try {
    const target = new URL(targetUrl)
    const page = new URL(pageUrl)
    if (action.application) {
      const job = /^\/jobs\/([0-9]+)(?:-[A-Za-z0-9-]+)?(?:\/apply)?\/?$/
      const expected = job.exec(target.pathname)?.[1]
      return (
        page.origin === target.origin &&
        expected !== undefined &&
        job.exec(page.pathname)?.[1] === expected
      )
    }
    return (
      page.origin === target.origin &&
      page.pathname.replace(/\/$/, '').toLowerCase() ===
        target.pathname.replace(/\/$/, '').toLowerCase()
    )
  } catch {
    return false
  }
}

/**
 * Names that commit or change account state. Matched as whole words in the accessible name,
 * so "Comments (12)" (opening a section) is allowed while "Comment" and "Post comment" are not.
 */
const COMMIT_WORDS = [
  'post',
  'comment',
  'reply',
  'submit',
  'send',
  'share',
  'publish',
  'apply',
  'confirm',
  'delete',
  'remove',
  'follow',
  'unfollow',
  'vote',
  'upvote',
  'downvote',
  'report',
  'block',
  'logout',
  'log out',
  'sign out',
  'settings',
  'join',
  'leave',
  'subscribe',
  'unsubscribe',
  'award',
]
const COMMIT_LEXICON = new RegExp(
  `\\b(${COMMIT_WORDS.map((w) => w.replace(' ', '\\s+')).join('|')})\\b`,
  'i',
)

export function isCommitLikeName(name: string): boolean {
  return COMMIT_LEXICON.test(name)
}

export function matchesElement(
  matcher: ElementMatcher,
  element: Pick<SnapshotElement, 'role' | 'name'>,
): boolean {
  return matcher.role === element.role && matcher.name.test(element.name.trim())
}

/** Elements a task acts on: its field inputs, its commit control, and its composer openers. */
export function isTaskControl(
  action: SiteAction,
  element: Pick<SnapshotElement, 'role' | 'name'>,
): boolean {
  return (
    action.fields.some(
      (field) =>
        field.roles.includes(element.role) &&
        (field.name === undefined || field.name.test(element.name.trim())),
    ) ||
    matchesElement(action.commit, element) ||
    action.preCommitOpeners.some((matcher) => matchesElement(matcher, element))
  )
}

/**
 * `click(ref)` before approval: commit-like names are refused unless the registry lists the
 * element as a pre-commit opener for this action; the action's own commit control is always
 * refused (only the executor clicks it, after approval). Links must stay on allowed origins.
 */
export function assertClickAllowed(
  site: Site,
  action: SiteAction,
  element: SnapshotElement,
  pageUrl: string,
): void {
  if (element.flags.includes('disabled')) {
    throw new GuardError('element_disabled', 'that element is disabled')
  }
  if (matchesElement(action.commit, element)) {
    throw new GuardError(
      'commit_requires_approval',
      'that control submits the action; call request_submit_approval instead of clicking it',
    )
  }
  const opener = action.preCommitOpeners.some((matcher) => matchesElement(matcher, element))
  if (!opener && isCommitLikeName(element.name)) {
    throw new GuardError(
      'commit_like_click',
      `clicking "${element.name}" could commit or change account state`,
    )
  }
  if (element.url !== undefined) {
    let target: string
    try {
      target = new URL(element.url, pageUrl).toString()
    } catch {
      throw new GuardError('origin_not_allowed', 'that link has an invalid URL')
    }
    assertAllowedOrigin(site, target)
  }
}

/** `fill_field(ref, fieldKey)`: only spec keys the action defines, only into allowed roles. */
export function resolveFillValue(
  action: SiteAction,
  spec: BrowserTaskSpecV1,
  fieldKey: string,
  element: SnapshotElement,
): string {
  const field = action.fields.find((candidate) => candidate.key === fieldKey)
  if (!field)
    throw new GuardError('unknown_field', `"${fieldKey}" is not a field of ${action.label}`)
  const specField = spec.fields.find((candidate) => candidate.key === fieldKey)
  if (!specField)
    throw new GuardError('field_not_in_spec', `this task has no value for "${fieldKey}"`)
  if (!field.roles.includes(element.role)) {
    throw new GuardError(
      'wrong_field_role',
      `"${fieldKey}" must be filled into a ${field.roles.join('/')}, not a ${element.role}`,
    )
  }
  if (field.name && !field.name.test(element.name.trim())) {
    throw new GuardError('wrong_field_name', `use the ${field.label} field for "${fieldKey}"`)
  }
  if (element.flags.includes('disabled'))
    throw new GuardError('element_disabled', 'that field is disabled')
  return specField.value
}

export const SEARCH_ROLES = ['searchbox', 'combobox'] as const
export const SEARCH_QUERY_MAX_CHARS = 200

/** `type_search(ref, query)`: bounded, single-line free text, search/combo boxes only. */
export function assertSearchInput(element: SnapshotElement, query: string): void {
  if (!(SEARCH_ROLES as readonly string[]).includes(element.role)) {
    throw new GuardError(
      'not_a_search_box',
      'free text may only be typed into a search box or combo box',
    )
  }
  if (query.length === 0 || query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new GuardError(
      'query_bounds',
      `search queries must be 1–${SEARCH_QUERY_MAX_CHARS} characters`,
    )
  }
  if (/[\r\n\t]/.test(query))
    throw new GuardError('query_bounds', 'search queries must be one line')
}

const NAVIGATION_KEYS = new Set([
  'Tab',
  'Shift+Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
])

/**
 * `press(key)`: navigation keys anywhere; Enter only with a search box or combo box focused
 * target. Any Ctrl/Meta/Alt chord (including Ctrl/Meta+Enter submit shortcuts) is refused.
 */
export function assertKeyAllowed(key: string, target: SnapshotElement | undefined): void {
  if (NAVIGATION_KEYS.has(key)) return
  if (key === 'Enter') {
    if (target && (SEARCH_ROLES as readonly string[]).includes(target.role)) return
    throw new GuardError(
      'key_not_allowed',
      'Enter is only allowed with a search box or combo box ref',
    )
  }
  throw new GuardError('key_not_allowed', `key "${key}" is not allowed`)
}

/** Bounded scroll/wait arguments. */
export const WAIT_MAX_MS = 5_000
export function assertWaitMs(ms: number): void {
  if (!Number.isInteger(ms) || ms < 100 || ms > WAIT_MAX_MS) {
    throw new GuardError('wait_bounds', `wait must be 100–${WAIT_MAX_MS} ms`)
  }
}
