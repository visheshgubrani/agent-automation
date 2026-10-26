/**
 * Bounded plain-text Telegram cards for browser tasks (phase 05). Every card is built from
 * stored rows or the immutable approval payload; page text never enters a card.
 */
import { getSiteAction } from '../browser/sites.js'
import type { BrowserHandoffRow, BrowserTaskRow } from '../db/schema/browser.js'
import type { InlineButton, InlineButtonRows } from '../telegram/buttons.js'
import type {
  BrowserSubmitApprovalPayloadV1,
  BrowserTaskResultV1,
  BrowserTaskStatusReason,
} from './contracts.js'

/** Same bound as the mail cards; the outbox body limit is 4096 characters. */
export const CARD_MAX_CHARS = 3_800

/** Short human task id: the first four hex characters of the uuid. */
export function shortTaskId(taskId: string): string {
  return taskId.replaceAll('-', '').slice(0, 4)
}

export function taskLabels(
  siteKey: string,
  actionKey: string,
): {
  siteLabel: string
  actionLabel: string
} {
  const found = getSiteAction(siteKey, actionKey)
  return {
    siteLabel: found?.site.label ?? siteKey,
    actionLabel: found?.action.label ?? actionKey,
  }
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function bounded(lines: string[]): string {
  return clip(lines.join('\n').trim(), CARD_MAX_CHARS)
}

export function formatCardTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function stopButton(taskId: string): InlineButton {
  return { text: 'Stop', callbackData: `bt:stop:${taskId}` }
}

export function retryButton(taskId: string): InlineButton {
  return { text: 'Retry', callbackData: `bt:retry:${taskId}` }
}

export function openBrowserButton(viewUrl: string): InlineButton {
  return { text: 'Open browser', url: viewUrl }
}

export function approvalButtons(approvalId: string): InlineButtonRows {
  return [
    [
      { text: 'Approve', callbackData: `bt:ap:${approvalId}` },
      { text: 'Cancel', callbackData: `bt:no:${approvalId}` },
    ],
  ]
}

export function queuedButtons(taskId: string): InlineButtonRows {
  return [[stopButton(taskId)]]
}

export function handoffButtons(
  taskId: string,
  handoffId: string,
  viewUrl: string,
): InlineButtonRows {
  return [
    [openBrowserButton(viewUrl)],
    [{ text: 'Done', callbackData: `bt:done:${handoffId}` }, stopButton(taskId)],
  ]
}

export function renderHandoffCard(
  task: BrowserTaskRow,
  handoff: BrowserHandoffRow,
  viewUrl: string,
): string {
  // Keep the link before the bounded page URL so it is always available in the text fallback.
  return bounded([
    `Task #${shortTaskId(task.id)} needs your help: ${handoff.reason}.`,
    `Open browser: ${viewUrl}`,
    'Fix the page in the browser, then tap Done. Tap Stop to cancel.',
    `Expires ${formatCardTime(handoff.expiresAt)}. Nothing has been submitted.`,
    ...(handoff.detail ? [`Reason: ${clip(handoff.detail, 300)}`] : []),
    ...(handoff.pageUrl ? [`Page: ${handoff.pageUrl}`] : []),
  ])
}

export interface NoticeButtonsOptions {
  viewUrl?: string
  openBrowser?: boolean
  retry?: boolean
}

export function noticeButtons(
  taskId: string,
  options: NoticeButtonsOptions = {},
): InlineButtonRows {
  const rows: InlineButtonRows = []
  if (options.retry !== false) rows.push([retryButton(taskId)])
  if (options.openBrowser && options.viewUrl) rows.push([openBrowserButton(options.viewUrl)])
  return rows
}

export function renderQueuedCard(task: BrowserTaskRow): string {
  const { actionLabel } = taskLabels(task.site, task.action)
  return bounded([
    `Task #${shortTaskId(task.id)} queued: ${actionLabel} on ${task.targetUrl}`,
    'You will approve the exact submission before it is sent. Tap Stop to cancel.',
  ])
}

/**
 * The approval card lists every field's exact value. Agent-written text is labelled
 * "(drafted)" so the user knows which words they did not write (D046).
 */
export function renderApprovalCard(
  payload: Pick<
    BrowserSubmitApprovalPayloadV1,
    'site' | 'action' | 'targetUrl' | 'pageUrl' | 'submit'
  > & {
    fields: readonly Pick<
      BrowserSubmitApprovalPayloadV1['fields'][number],
      'label' | 'value' | 'provenance'
    >[]
  },
  options: { expiresAt: Date },
): string {
  const { siteLabel, actionLabel } = taskLabels(payload.site, payload.action)
  const lines = [
    `Approve: ${siteLabel} ${actionLabel.toLowerCase()}?`,
    `Target: ${payload.targetUrl}`,
  ]
  if (payload.action === 'reddit_post') {
    const subreddit = /^https:\/\/www\.reddit\.com\/r\/([^/]+)\//.exec(payload.targetUrl)?.[1]
    if (subreddit) lines.push(`Subreddit: r/${subreddit}`)
  }
  if (payload.pageUrl !== payload.targetUrl) lines.push(`Page: ${payload.pageUrl}`)
  for (const field of payload.fields) {
    const provenance = field.provenance === 'drafted' ? 'drafted' : 'verbatim'
    lines.push(`${field.label} (${provenance}):`)
    lines.push(field.value)
  }
  lines.push(`Submit button: ${payload.submit.role} "${payload.submit.name}"`)
  lines.push(`Expires ${formatCardTime(options.expiresAt)}. Nothing is sent until you tap Approve.`)
  const text = lines.join('\n').trim()
  if (text.length > CARD_MAX_CHARS)
    throw new Error(
      'The complete approval text exceeds the Telegram card limit; shorten the fields.',
    )
  return text
}

export function draftTaskButtons(taskId: string): InlineButtonRows {
  return [[{ text: 'Start', callbackData: `bt:go:${taskId}` }, stopButton(taskId)]]
}

export function renderTaskDraft(task: BrowserTaskRow, expiresAt: Date): string {
  return bounded([
    `Task #${shortTaskId(task.id)} — confirm this older request`,
    `${taskLabels(task.site, task.action).actionLabel} on ${task.targetUrl}`,
    'This message is older than 10 minutes or its send time is missing. Tap Start to prepare it, or Stop to cancel.',
    'You will still approve the exact text before anything is submitted.',
    `Expires ${formatCardTime(expiresAt)}.`,
  ])
}

function resultStateLine(task: BrowserTaskRow): string {
  const reason: BrowserTaskStatusReason | string | null = task.statusReason
  switch (task.status) {
    case 'succeeded':
      return 'Succeeded.'
    case 'unverified':
      return 'Submitted, not verified. Open the page to confirm it appeared.'
    case 'outcome_unknown':
      return 'Submitted, but the outcome is unknown. Check the browser before retrying.'
    case 'cancelled':
      return 'Cancelled. Nothing was submitted.'
    case 'failed':
      switch (reason) {
        case 'schedule_missed':
          return 'Scheduled run skipped because it was more than 30 minutes late. Nothing was submitted.'
        case 'already_applied':
          return 'Already applied. Read-only check complete; nothing was submitted.'
        case 'daily_cap':
          return 'Daily cap reached. Nothing was submitted; try again tomorrow.'
        case 'approval_expired':
          return 'The approval expired before submitting. Nothing was submitted.'
        case 'budget_exhausted':
          return 'The agent budget is used up for today. Nothing was submitted.'
        case 'step_limit':
          return 'The agent hit its step limit before preparing the submission. Nothing was submitted.'
        case 'login_required':
          return 'A login or verification page blocked the task. Log in through the browser view, then tap Retry. Nothing was submitted.'
        case 'handoff_timeout':
          return 'The wait for your help timed out. Nothing was submitted. Tap Retry to start again.'
        case 'handoff_limit':
          return 'The page still needs help after three handoffs. Nothing was submitted. Check the browser before retrying.'
        case 'interrupted':
          return 'The worker restarted before submitting. Nothing was submitted.'
        default:
          return 'The task stopped before submitting. Nothing was submitted.'
      }
    default:
      return `Status: ${task.status}.`
  }
}

export function renderResultCard(task: BrowserTaskRow, result?: BrowserTaskResultV1): string {
  const { actionLabel } = taskLabels(task.site, task.action)
  const lines = [`Task #${shortTaskId(task.id)} — ${actionLabel}`, resultStateLine(task)]
  if (result?.evidenceUrl !== undefined) lines.push(`Link: ${result.evidenceUrl}`)
  if (result?.summary !== undefined && result.summary.length > 0) {
    lines.push(`Note: ${clip(result.summary, 400)}`)
  }
  return bounded(lines)
}

/**
 * Result-card buttons: Retry for recoverable failures, Open browser where the user must look
 * at the live page (unknown outcome, unverified submission, login blocking).
 */
export function resultButtons(
  task: BrowserTaskRow,
  options: { viewUrl?: string } = {},
): InlineButtonRows {
  const open = options.viewUrl !== undefined ? openBrowserButton(options.viewUrl) : undefined
  switch (task.status) {
    case 'outcome_unknown': {
      const rows: InlineButtonRows = []
      if (open) rows.push([open])
      rows.push([retryButton(task.id)])
      return rows
    }
    case 'unverified':
      return open ? [[open]] : []
    case 'failed': {
      if (task.statusReason === 'already_applied') return []
      const rows: InlineButtonRows = []
      if (
        open &&
        ['login_required', 'handoff_timeout', 'handoff_limit'].includes(task.statusReason ?? '')
      )
        rows.push([open])
      rows.push([retryButton(task.id)])
      return rows
    }
    default:
      return []
  }
}

/**
 * Startup/drain notice. The worker lock means no other process can have finished the task,
 * so an `outcome_unknown` notice tells the user to check the browser before retrying.
 */
export function renderRecoveryNotice(task: BrowserTaskRow): string {
  const { actionLabel } = taskLabels(task.site, task.action)
  const detail =
    task.status === 'outcome_unknown'
      ? 'The submission may have happened and the outcome is unknown. Check the browser before retrying.'
      : task.status === 'unverified'
        ? 'The submission was sent but could not be verified. Check the browser before retrying.'
        : 'Nothing was submitted.'
  return bounded([
    `Task #${shortTaskId(task.id)} — ${actionLabel}`,
    'Interrupted by a worker restart or shutdown.',
    detail,
  ])
}

/** Reddit drafting advice cards contain a generated question, never a raw page excerpt. */
export function renderCommentAdviceCard(taskId: string, question: string): string {
  return `quick question for comment #${shortTaskId(taskId)}:\n${question}\n\nreply to this message with your thoughts, or tap Stop.`
}

export function renderCommentAdviceReply(status: 'accepted' | 'invalid' | 'stale'): string {
  if (status === 'invalid') return 'Please reply with 1–3000 characters of context.'
  if (status === 'stale')
    return 'This question is no longer waiting for an answer. Send a new /comment request if needed.'
  return 'got it, preparing the comment. you’ll get the exact text to approve.'
}

export function renderIntakeUsage(): string {
  return [
    'Usage: /comment <reddit thread url> [your thoughts]',
    'I’ll read the post and draft a short comment. Optional thoughts can follow the URL or go on the next lines.',
    '',
    '/comment https://www.reddit.com/r/test/comments/abc123/title/',
    'imo the simpler approach makes more sense here',
    'You’ll approve the finished comment before it is posted.',
  ].join('\n')
}

export function renderScheduleDraft(
  plan: { cron: string; site: string; action: string; spec: { targetUrl: string } },
  times: Date[],
): string {
  return bounded([
    `Save schedule: ${taskLabels(plan.site, plan.action).actionLabel}?`,
    `Cron: ${plan.cron} (Asia/Kolkata; at least one hour apart)`,
    `Target: ${plan.spec.targetUrl}`,
    'Next three runs (Asia/Kolkata):',
    ...times.map(formatScheduleTime),
    'This draft will not run or submit anything until you tap Save. Every run still asks you to approve its exact submission.',
    'Missed occurrences more than 30 minutes late are skipped. Draft expires in 30 minutes.',
  ])
}

export function formatScheduleTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(date)
}
