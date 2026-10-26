/**
 * Intake validation (D046/D050): deterministic `/comment` parsing and validation of a
 * structured current-message parse. Values are pinned before any page is read.
 */

import { z } from 'zod'
import { isAllowedOrigin } from '../browser/guards.js'
import { getSiteAction } from '../browser/sites.js'
import {
  BROWSER_FIELD_VALUE_MAX_CHARS,
  type BrowserTaskSpecV1,
  browserTaskSpecV1,
} from './contracts.js'
import { INTAKE_MESSAGE_MAX_CHARS, type IntakeOutput, intakeOutputSchema } from './intake-prompt.js'
import { renderApprovalCard } from './render.js'

export const COMMENT_ACTION = { site: 'reddit', action: 'reddit_comment' } as const
export const COMMENT_FIELD_KEY = 'comment_text'

/** Reddit hosts a user may paste; the browser only visits the canonical www origin. */
const REDDIT_THREAD_HOSTS = new Set(['www.reddit.com', 'reddit.com', 'old.reddit.com'])

const COMMENT_COMMAND_LINE = /^\/comment(?:@[A-Za-z0-9_]+)?\s+(\S+)(?:\s+([\s\S]*))?$/i

export interface CommentCommand {
  targetUrl: string
  thoughts: string
}

/** Canonical `https://www.reddit.com/r/<sub>/comments/<id>/…` URL, or undefined. */
export function normalizeRedditThreadUrl(value: string): string | undefined {
  if (value.length > 2_048) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined
  if (!REDDIT_THREAD_HOSTS.has(url.hostname.toLowerCase())) return undefined

  url.hostname = 'www.reddit.com'
  url.hash = ''
  const found = getSiteAction(COMMENT_ACTION.site, COMMENT_ACTION.action)
  if (!found) return undefined
  const normalized = url.toString()
  if (!isAllowedOrigin(found.site, normalized)) return undefined
  if (!found.action.targetUrlPattern.test(normalized)) return undefined
  return normalized
}

/** Optional same-line or multiline thoughts guide composition after reading the post. */
export function parseCommentCommand(text: string): CommentCommand | undefined {
  if (text.length > INTAKE_MESSAGE_MAX_CHARS) return undefined
  const match = COMMENT_COMMAND_LINE.exec(text.trim())
  if (!match?.[1]) return undefined
  const targetUrl = normalizeRedditThreadUrl(match[1])
  const thoughts = (match[2] ?? '').trim()
  if (!targetUrl || thoughts.length > BROWSER_FIELD_VALUE_MAX_CHARS) return undefined
  return { targetUrl, thoughts }
}

export function buildCommentSpec(command: CommentCommand): BrowserTaskSpecV1 {
  return browserTaskSpecV1.parse({
    version: 1,
    targetUrl: command.targetUrl,
    fields: [],
    composeComment: { thoughts: command.thoughts },
  })
}

/** The persisted decision is separate from the raw Telegram update. */
const actionPlan = z.object({
  site: z.enum(['reddit', 'waas', 'wellfound']),
  action: z.enum(['reddit_comment', 'reddit_post', 'waas_apply', 'wellfound_apply']),
  spec: browserTaskSpecV1,
})
export const intakePlanV1 = z.discriminatedUnion('kind', [
  actionPlan.extend({ version: z.literal(1), kind: z.literal('one_off') }).strict(),
  actionPlan
    .extend({
      version: z.literal(1),
      kind: z.literal('schedule'),
      cron: z.string().min(1).max(120),
      timezone: z.literal('Asia/Kolkata'),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal('unclear'),
      question: z.string().min(1).max(300),
    })
    .strict(),
  z.object({ version: z.literal(1), kind: z.literal('invalid') }).strict(),
])
export type IntakePlan = z.infer<typeof intakePlanV1>
export type ActionIntakePlan = Extract<IntakePlan, { kind: 'one_off' | 'schedule' }>

export function clarification(
  question = 'Please send one action with its target URL and exact text, or ask me to draft an application note from your profile.',
): IntakePlan {
  return { version: 1, kind: 'unclear', question }
}

export function normalizeRedditPostUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !REDDIT_THREAD_HOSTS.has(url.hostname.toLowerCase())
  )
    return undefined
  const match = /^\/r\/([A-Za-z0-9_]{2,21})(?:\/submit)?\/?$/.exec(url.pathname)
  return match ? `https://www.reddit.com/r/${match[1]}/submit` : undefined
}

export function subredditFromTarget(targetUrl: string): string | undefined {
  return /^https:\/\/www\.reddit\.com\/r\/([A-Za-z0-9_]{2,21})\//.exec(targetUrl)?.[1]
}

/** Canonical job URL; query/fragment cannot carry a different application target. */
export function normalizeApplicationUrl(siteKey: string, value: string): string | undefined {
  const found = getSiteAction(siteKey, `${siteKey}_apply`)
  if (!found || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (!isAllowedOrigin(found.site, value) || url.port) return undefined
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/$/, '')
    const target = url.toString()
    return found.action.targetUrlPattern.test(target) ? target : undefined
  } catch {
    return undefined
  }
}

/** Reject unsafe parses before creating a task, independently of model instructions. */
export function validateIntakeOutput(value: unknown, text: string): IntakePlan {
  const parsed = intakeOutputSchema.safeParse(value)
  if (!parsed.success) return clarification()
  const output: IntakeOutput = parsed.data
  if (output.kind === 'unclear') return clarification(output.question || undefined)
  const found = getSiteAction(output.site ?? '', output.action ?? '')
  if (!found)
    return clarification(
      'I can prepare Reddit comments/posts and YC Work at a Startup or Wellfound application notes. Please specify one of those actions.',
    )
  const site = found.site.key as 'reddit' | 'waas' | 'wellfound'
  const action = found.action.key as ActionIntakePlan['action']
  const application = Boolean(found.action.application)
  const targetUrl = application
    ? normalizeApplicationUrl(site, output.targetUrl ?? '')
    : action === 'reddit_comment'
      ? normalizeRedditThreadUrl(output.targetUrl ?? '')
      : normalizeRedditPostUrl(output.targetUrl ?? '')
  if (!targetUrl)
    return clarification(
      'Please supply a supported job URL, Reddit thread URL, or r/<subreddit> for a text post.',
    )
  const explicitTarget = application
    ? (text.match(/https:\/\/[^\s<>"']+/g) ?? []).some(
        (url) => normalizeApplicationUrl(site, url.replace(/[),.!?]+$/, '')) === targetUrl,
      )
    : action === 'reddit_comment'
      ? (text.match(/https:\/\/[^\s<>"']+/g) ?? []).some(
          (url) => normalizeRedditThreadUrl(url.replace(/[),.!?]+$/, '')) === targetUrl,
        )
      : new RegExp(
          `(?:^|[^A-Za-z0-9_])r/${subredditFromTarget(targetUrl)}(?:[^A-Za-z0-9_]|$)`,
          'i',
        ).test(text)
  if (!explicitTarget)
    return clarification(
      'Please include the target job/thread URL or r/<subreddit> explicitly in your message.',
    )
  // Generated application text comes only from the profile composer, never intake.
  const composeNote =
    application &&
    (output.fields.length === 0 || output.fields.some((field) => field.provenance === 'drafted'))
  const spec = browserTaskSpecV1.safeParse({
    version: 1,
    targetUrl,
    fields: composeNote ? [] : output.fields,
    ...(composeNote ? { composeNote: true } : {}),
  })
  if (
    !found ||
    !spec.success ||
    (!composeNote && spec.data.fields.length !== found.action.fields.length) ||
    (!composeNote &&
      found.action.fields.some(
        (field) => !spec.data.fields.some((candidate) => candidate.key === field.key),
      ))
  )
    return clarification(
      'Please provide the exact fields for one action, or request an application note from your profile.',
    )
  if (
    spec.data.fields.some(
      (field) => field.provenance === 'user_verbatim' && !text.includes(field.value),
    )
  )
    return clarification(
      'The parsed verbatim text did not exactly match your message. Please send the exact title and body, or comment, again.',
    )
  if (
    action === 'reddit_post' &&
    spec.data.fields.some((field) => field.key === 'post_title' && field.value.length > 300)
  )
    return clarification('Please shorten the Reddit post title to 300 characters or fewer.')
  // The full approval must fit in Telegram; never silently truncate one of its fields.
  try {
    renderApprovalCard(
      {
        site,
        action,
        targetUrl,
        pageUrl: targetUrl,
        fields: spec.data.fields.map((field) => ({
          ...field,
          label: found.action.fields.find((entry) => entry.key === field.key)?.label ?? field.key,
        })),
        submit: { role: 'button', name: action === 'reddit_post' ? 'Post' : 'Comment' },
      },
      { expiresAt: new Date(0) },
    )
  } catch {
    return clarification(
      'Please shorten the combined text so every field fits in one complete Telegram approval card.',
    )
  }
  const common = { version: 1 as const, site, action, spec: spec.data }
  if (output.kind === 'schedule') {
    const cron = output.cron?.trim() ?? ''
    if (
      cron.split(/\s+/).length !== 5 ||
      !cron.split(/\s+/).every((part) => /^[0-9*,/-]+$/.test(part))
    )
      return clarification('Please include an unambiguous recurring time in Asia/Kolkata.')
    return { ...common, kind: 'schedule', cron, timezone: 'Asia/Kolkata' }
  }
  if (output.cron !== null)
    return clarification('Please clarify whether this should run once or on a recurring schedule.')
  return { ...common, kind: 'one_off' }
}

/** Telegram's message timestamp is the replay boundary, never the receive/DB creation time. */
export function isStaleRequest(payload: Record<string, unknown>, now: Date): boolean {
  const date = (payload.message as { date?: unknown } | undefined)?.date
  return (
    typeof date !== 'number' || !Number.isFinite(date) || date * 1_000 < now.getTime() - 10 * 60_000
  )
}
