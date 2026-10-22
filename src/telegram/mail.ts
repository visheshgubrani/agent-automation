/**
 * Deterministic Telegram mail surface: commands, paginated review/search, callbacks, feedback,
 * corrections, and rule previews. No model calls; every callback is validated against stored state.
 */
import type { Db } from '../db/index.js'
import { findAccountByEmail } from '../db/queries/accounts.js'
import type { Logger } from '../logger.js'
import {
  applyMessageCorrection,
  findNotificationForCallback,
  InvalidCorrectionError,
  StaleClassificationError,
} from '../mail/corrections.js'
import {
  findOutboundTelegramMessage,
  listIgnoredMail,
  loadDisplayedClassification,
  type ReviewItem,
  type ReviewPage,
  searchMail,
} from '../mail/review.js'
import {
  createMailRule,
  disableMailRule,
  listRulesPage,
  normalizeRuleMatchValue,
  normalizeRuleSubject,
  type RuleAction,
  type RuleMatchType,
  RuleValidationError,
} from '../mail/rules-admin.js'
import { getMailStatusSummary, type MailStatusSummary } from '../mail/status.js'
import type { InlineButton, InlineButtonRows } from './buttons.js'

const MAX_REPLY_TEXT = 3_900
const MAX_CALLBACK_ANSWER = 200
const MAIL_REVIEW_PAYLOAD_KEY = 'mailReview'
const MAIL_RULE_DRAFT_PAYLOAD_KEY = 'mailRuleDraft'
const MAIL_RULE_LIST_PAYLOAD_KEY = 'mailRuleList'

export interface TelegramReplyOptions {
  buttons?: InlineButtonRows
  /** App metadata stored with the outbound Telegram message; never sent to Telegram. */
  payload?: Record<string, unknown>
}

export interface TelegramResponder {
  reply(text: string, options?: TelegramReplyOptions): Promise<number>
  editMessage(messageId: number, text: string, options?: TelegramReplyOptions): Promise<void>
  answerCallback(text?: string): Promise<void>
  hasAnsweredCallback(): boolean
}

export interface MailHandlerContext {
  db: Db
  chatDbId: string
  runId: string
  responder: TelegramResponder
  log: Logger
}

interface StoredMailReview {
  version: 1
  kind: 'ignored' | 'search'
  page: number
  query?: string
  classificationIds: string[]
}

interface StoredRuleDraft {
  version: 1
  action: RuleAction
  matchType: RuleMatchType
  matchValue: string
  subjectContains: string | null
  accountId: string | null
  accountEmail: string | null
  sourceAccountId: string | null
  sourceAccountEmail: string | null
  sourceFromEmail: string | null
  sourceClassificationId: string | null
  savedRuleId?: string
  cancelled?: boolean
}

interface StoredRuleList {
  version: 1
  page: number
  ruleIds: string[]
}

type MailCallback =
  | { kind: 'feedback'; classificationId: string; important: boolean }
  | { kind: 'create_rule'; classificationId: string }
  | { kind: 'rule_save' }
  | { kind: 'rule_cancel' }
  | { kind: 'rule_action' }
  | { kind: 'rule_match' }
  | { kind: 'rule_scope' }
  | { kind: 'rule_disable'; ruleId: string }
  | { kind: 'ignored_page'; page: number }
  | { kind: 'search_page'; page: number }
  | { kind: 'rules_page'; page: number }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function clip(value: string, limit: number): string {
  if (limit <= 0) return ''
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function answerText(value: string): string {
  return clip(value, MAX_CALLBACK_ANSWER)
}

function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')}Z`
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`
}

function senderLabel(item: Pick<ReviewItem, 'fromEmail' | 'fromName'>): string {
  return item.fromName ? `${item.fromName} <${item.fromEmail}>` : item.fromEmail
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  return at === -1 ? null : email.slice(at + 1).toLowerCase()
}

function parsePage(value: string | undefined): number | undefined {
  if (value === undefined) return 0
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return undefined
  return parsed - 1
}

function parseCallbackPage(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) return undefined
  return parsed
}

export function parseMailCallback(data: string): MailCallback | undefined {
  const parts = data.split(':')
  if (parts[0] !== 'mail') return undefined
  const action = parts[1]

  if (action === 'important' || action === 'useful' || action === 'not_important') {
    const id = parts[2]
    return id && isUuid(id)
      ? { kind: 'feedback', classificationId: id, important: action !== 'not_important' }
      : undefined
  }
  if (action === 'create_rule' || action === 'rule') {
    const id = parts[2]
    return id && isUuid(id) ? { kind: 'create_rule', classificationId: id } : undefined
  }
  if (
    action === 'rule_save' ||
    action === 'rule_cancel' ||
    action === 'rule_action' ||
    action === 'rule_match' ||
    action === 'rule_scope'
  ) {
    return { kind: action }
  }
  if (action === 'rule_disable') {
    const id = parts[2]
    return id && isUuid(id) ? { kind: 'rule_disable', ruleId: id } : undefined
  }
  if (action === 'ignored_page' || action === 'search_page' || action === 'rules_page') {
    const page = parseCallbackPage(parts[2])
    if (page === undefined) return undefined
    return { kind: action, page }
  }
  return undefined
}

function readReviewPayload(
  payload: Record<string, unknown> | null | undefined,
): StoredMailReview | undefined {
  const value = payload?.[MAIL_REVIEW_PAYLOAD_KEY]
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<StoredMailReview>
  if (
    candidate.version !== 1 ||
    (candidate.kind !== 'ignored' && candidate.kind !== 'search') ||
    typeof candidate.page !== 'number' ||
    !Array.isArray(candidate.classificationIds) ||
    candidate.classificationIds.some((id) => typeof id !== 'string')
  ) {
    return undefined
  }
  if (candidate.kind === 'search' && typeof candidate.query !== 'string') return undefined
  return {
    version: 1,
    kind: candidate.kind,
    page: candidate.page,
    classificationIds: candidate.classificationIds,
    ...(candidate.kind === 'search' ? { query: candidate.query as string } : {}),
  }
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function readRuleDraftPayload(
  payload: Record<string, unknown> | null | undefined,
): StoredRuleDraft | undefined {
  const value = payload?.[MAIL_RULE_DRAFT_PAYLOAD_KEY]
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<StoredRuleDraft>
  if (
    candidate.version !== 1 ||
    (candidate.action !== 'notify' && candidate.action !== 'ignore') ||
    (candidate.matchType !== 'sender' && candidate.matchType !== 'domain') ||
    typeof candidate.matchValue !== 'string' ||
    !nullableString(candidate.subjectContains) ||
    !nullableString(candidate.accountId) ||
    !nullableString(candidate.accountEmail) ||
    !nullableString(candidate.sourceAccountId) ||
    !nullableString(candidate.sourceAccountEmail) ||
    !nullableString(candidate.sourceFromEmail) ||
    !nullableString(candidate.sourceClassificationId) ||
    (candidate.savedRuleId !== undefined && typeof candidate.savedRuleId !== 'string') ||
    (candidate.cancelled !== undefined && typeof candidate.cancelled !== 'boolean')
  ) {
    return undefined
  }
  return {
    version: 1,
    action: candidate.action,
    matchType: candidate.matchType,
    matchValue: candidate.matchValue,
    subjectContains: candidate.subjectContains,
    accountId: candidate.accountId,
    accountEmail: candidate.accountEmail,
    sourceAccountId: candidate.sourceAccountId,
    sourceAccountEmail: candidate.sourceAccountEmail,
    sourceFromEmail: candidate.sourceFromEmail,
    sourceClassificationId: candidate.sourceClassificationId,
    ...(candidate.savedRuleId !== undefined ? { savedRuleId: candidate.savedRuleId } : {}),
    ...(candidate.cancelled !== undefined ? { cancelled: candidate.cancelled } : {}),
  }
}

function readRuleListPayload(
  payload: Record<string, unknown> | null | undefined,
): StoredRuleList | undefined {
  const value = payload?.[MAIL_RULE_LIST_PAYLOAD_KEY]
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<StoredRuleList>
  if (
    candidate.version !== 1 ||
    typeof candidate.page !== 'number' ||
    !Array.isArray(candidate.ruleIds) ||
    candidate.ruleIds.some((id) => typeof id !== 'string')
  ) {
    return undefined
  }
  return { version: 1, page: candidate.page, ruleIds: candidate.ruleIds }
}

function reviewItemLines(item: ReviewItem, index: number): string[] {
  const state =
    item.classificationId === null ? 'Not classified' : item.shouldNotify ? 'Important' : 'Ignored'
  const lines = [
    `${index + 1}. ${state} · ${formatTimestamp(item.receivedAt)} · ${item.accountEmail}`,
    `From: ${senderLabel(item)}`,
    `Subject: ${clip(item.subject, 160)}`,
  ]
  if (item.summary) {
    lines.push(`Summary: ${clip(item.summary, 180)}`)
  }
  return lines
}

function paginationRow(kind: 'ignored' | 'search', page: ReviewPage): InlineButton[] {
  const prefix = kind === 'ignored' ? 'mail:ignored_page:' : 'mail:search_page:'
  const buttons: InlineButton[] = []
  if (page.page > 0) buttons.push({ text: 'Prev', callbackData: `${prefix}${page.page - 1}` })
  if (page.hasNext) buttons.push({ text: 'Next', callbackData: `${prefix}${page.page + 1}` })
  return buttons
}

function renderReviewPage(
  kind: 'ignored' | 'search',
  page: ReviewPage,
  query?: string,
): { text: string; buttons: InlineButtonRows; payload: Record<string, unknown> } {
  const title =
    kind === 'ignored'
      ? `Ignored mail — page ${page.page + 1}`
      : `Search: "${clip(query ?? '', 100)}" — page ${page.page + 1}`
  const lines = [title]
  if (page.items.length === 0) {
    lines.push(kind === 'ignored' ? 'No ignored mail.' : 'No matching mail.')
  }
  for (const [index, item] of page.items.entries()) {
    if (index > 0) lines.push('')
    lines.push(...reviewItemLines(item, index))
  }

  const buttons: InlineButtonRows = []
  for (const [index, item] of page.items.entries()) {
    if (item.classificationId === null) continue
    buttons.push([
      { text: `Important ${index + 1}`, callbackData: `mail:useful:${item.classificationId}` },
      {
        text: `Not important ${index + 1}`,
        callbackData: `mail:not_important:${item.classificationId}`,
      },
      {
        text: `Rule ${index + 1}`,
        callbackData: `mail:create_rule:${item.classificationId}`,
      },
    ])
  }
  const pagination = paginationRow(kind, page)
  if (pagination.length > 0) buttons.push(pagination)

  const classificationIds = page.items
    .map((item) => item.classificationId)
    .filter((id): id is string => id !== null)

  return {
    text: clip(lines.join('\n'), MAX_REPLY_TEXT),
    buttons,
    payload: {
      [MAIL_REVIEW_PAYLOAD_KEY]: {
        version: 1,
        kind,
        page: page.page,
        classificationIds,
        ...(kind === 'search' ? { query: query ?? '' } : {}),
      } satisfies StoredMailReview,
    },
  }
}

function renderRuleDraft(draft: StoredRuleDraft): {
  text: string
  buttons: InlineButtonRows
} {
  const lines = [
    'Create rule (not saved yet)',
    `Action: ${draft.action === 'notify' ? 'Notify' : 'Ignore'}`,
    `Match: ${draft.matchType} ${draft.matchValue}`,
    `Subject contains: ${draft.subjectContains ?? '(none)'}`,
    `Scope: ${draft.accountId !== null ? `Only ${draft.accountEmail ?? 'selected account'}` : 'All accounts'}`,
    'Applies to future mail only; past classifications are unchanged.',
  ]

  const actionButton: InlineButton = {
    text: draft.action === 'notify' ? 'Action: Ignore' : 'Action: Notify',
    callbackData: 'mail:rule_action',
  }
  const row: InlineButton[] = [actionButton]
  if (draft.matchType === 'sender') {
    row.push({ text: 'Match: domain', callbackData: 'mail:rule_match' })
  } else if (draft.sourceFromEmail) {
    row.push({ text: 'Match: sender', callbackData: 'mail:rule_match' })
  }

  const buttons: InlineButtonRows = [
    [
      { text: 'Save rule', callbackData: 'mail:rule_save' },
      { text: 'Cancel', callbackData: 'mail:rule_cancel' },
    ],
    row,
  ]

  if (draft.accountId !== null) {
    buttons.push([{ text: 'Scope: All accounts', callbackData: 'mail:rule_scope' }])
  } else if (draft.sourceAccountId && draft.sourceAccountEmail) {
    buttons.push([
      {
        text: `Scope: Only ${clip(draft.sourceAccountEmail, 28)}`,
        callbackData: 'mail:rule_scope',
      },
    ])
  }

  return { text: lines.join('\n'), buttons }
}

function renderRulesPage(page: Awaited<ReturnType<typeof listRulesPage>>): {
  text: string
  buttons: InlineButtonRows
  payload: Record<string, unknown>
} {
  const lines = [`Notification rules — page ${page.page + 1}`]
  if (page.rules.length === 0) {
    lines.push('No active rules.')
  }
  for (const [index, rule] of page.rules.entries()) {
    lines.push('')
    lines.push(
      `${index + 1}. ${rule.action === 'notify' ? 'Notify' : 'Ignore'} ${rule.matchType} ${rule.matchValue}`,
    )
    if (rule.subjectContains) lines.push(`   Subject contains: ${clip(rule.subjectContains, 100)}`)
    lines.push(`   Scope: ${rule.accountEmail ?? 'All accounts'}`)
    lines.push(`   Updated: ${formatTimestamp(rule.updatedAt)}`)
  }
  lines.push('')
  lines.push(
    'Add: /mail rules add <notify|ignore> <sender|domain> <value> [subject: text] [account: email]',
  )
  lines.push('Disable a rule with its button or /mail rules disable <id>.')

  const buttons: InlineButtonRows = page.rules.map((rule, index) => [
    { text: `Disable ${index + 1}`, callbackData: `mail:rule_disable:${rule.id}` },
  ])
  const pagination: InlineButton[] = []
  if (page.page > 0) {
    pagination.push({ text: 'Prev', callbackData: `mail:rules_page:${page.page - 1}` })
  }
  if (page.hasNext) {
    pagination.push({ text: 'Next', callbackData: `mail:rules_page:${page.page + 1}` })
  }
  if (pagination.length > 0) buttons.push(pagination)

  return {
    text: clip(lines.join('\n'), MAX_REPLY_TEXT),
    buttons,
    payload: {
      [MAIL_RULE_LIST_PAYLOAD_KEY]: {
        version: 1,
        page: page.page,
        ruleIds: page.rules.map((rule) => rule.id),
      } satisfies StoredRuleList,
    },
  }
}

export function formatMailStatus(summary: MailStatusSummary): string {
  const lines = ['Mail status']
  if (summary.accounts.length === 0) {
    lines.push('Accounts: none connected')
  } else {
    lines.push(`Accounts (${summary.accounts.length}):`)
    for (const account of summary.accounts) {
      const lastSuccess = account.lastSuccessAt
        ? `last success ${formatTimestamp(account.lastSuccessAt)}`
        : 'no successful sync yet'
      lines.push(
        `- ${account.emailAddress}: ${account.status}, ${lastSuccess}, ${account.consecutiveFailures} consecutive failure(s)`,
      )
      if (account.lastError) {
        lines.push(`  Last error: ${clip(account.lastError, 140)}`)
      }
    }
  }

  const limit =
    summary.spend.settings.dailyLimitUsd === null
      ? 'no daily limit'
      : `${formatUsd(summary.spend.settings.dailyLimitUsd)} limit`
  const remaining =
    summary.spend.remainingUsd === null
      ? ''
      : `; ${formatUsd(summary.spend.remainingUsd)} remaining`
  lines.push(
    `Backlog: ${summary.backlog.pending} pending/in-progress/failed, ${summary.backlog.runnable} runnable now`,
  )
  lines.push(`Failures: ${summary.backlog.failed} failed, ${summary.backlog.exhausted} exhausted`)
  lines.push(
    `Spend ${summary.spend.range.dayKey} (${summary.spend.settings.timezone}): ` +
      `${formatUsd(summary.spend.usage.actualUsd)} actual, ` +
      `${formatUsd(summary.spend.usage.reservedUsd)} held, ` +
      `${formatUsd(summary.spend.usage.totalUsd)} toward ${limit}${remaining}`,
  )
  lines.push(
    `Outbox: ${summary.outbox.due} due, ${summary.outbox.sending} sending, ` +
      `${summary.outbox.failed} failed, ${summary.outbox.quarantined} quarantined`,
  )
  return clip(lines.join('\n'), MAX_REPLY_TEXT)
}

function mailHelp(): string {
  return [
    'Mail commands',
    '/mail ignored [page] — review ignored mail',
    '/mail search <text> — search stored mail',
    '/mail rules [page] — list active rules',
    '/mail rules add <notify|ignore> <sender|domain> <value> [subject: text] [account: email]',
    '/mail rules disable <id> — disable a rule',
    '/mail status — account health, backlog, and spend',
  ].join('\n')
}

async function sendReview(
  context: MailHandlerContext,
  kind: 'ignored' | 'search',
  page: number,
  query?: string,
): Promise<void> {
  const result =
    kind === 'ignored'
      ? await listIgnoredMail(context.db, { page })
      : await searchMail(context.db, { page, query: query ?? '' })
  const rendered = renderReviewPage(kind, result, query)
  await context.responder.reply(rendered.text, {
    buttons: rendered.buttons,
    payload: rendered.payload,
  })
}

async function sendRulesPage(context: MailHandlerContext, page: number): Promise<void> {
  const result = await listRulesPage(context.db, { page })
  const rendered = renderRulesPage(result)
  await context.responder.reply(rendered.text, {
    buttons: rendered.buttons,
    payload: rendered.payload,
  })
}

async function sendRulePreview(context: MailHandlerContext, draft: StoredRuleDraft): Promise<void> {
  const rendered = renderRuleDraft(draft)
  await context.responder.reply(rendered.text, {
    buttons: rendered.buttons,
    payload: { [MAIL_RULE_DRAFT_PAYLOAD_KEY]: draft },
  })
}

function parseRuleAddArgs(body: string):
  | {
      action: RuleAction
      matchType: RuleMatchType
      matchValue: string
      subjectContains: string | null
      accountEmail: string | null
    }
  | undefined {
  const tokens = body
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  const [actionRaw, matchTypeRaw, matchValue, ...rest] = tokens
  if (!actionRaw || !matchTypeRaw || !matchValue) return undefined
  const action = actionRaw.toLowerCase()
  const matchType = matchTypeRaw.toLowerCase()
  if (
    (action !== 'notify' && action !== 'ignore') ||
    (matchType !== 'sender' && matchType !== 'domain')
  ) {
    return undefined
  }

  let mode: 'subject' | 'account' | null = null
  const subjectParts: string[] = []
  const accountParts: string[] = []
  for (const token of rest) {
    const lower = token.toLowerCase()
    if (lower.startsWith('subject:')) {
      mode = 'subject'
      const inline = token.slice('subject:'.length)
      if (inline.length > 0) subjectParts.push(inline)
      continue
    }
    if (lower.startsWith('account:')) {
      mode = 'account'
      const inline = token.slice('account:'.length)
      if (inline.length > 0) accountParts.push(inline)
      continue
    }
    if (mode === 'subject') subjectParts.push(token)
    else if (mode === 'account') accountParts.push(token)
    else return undefined
  }

  const stripQuotes = (value: string): string => value.replace(/^["']|["']$/g, '')
  const subject = subjectParts.length > 0 ? stripQuotes(subjectParts.join(' ')) : null
  const accountEmail = accountParts.length > 0 ? stripQuotes(accountParts.join(' ')) : null

  return {
    action,
    matchType,
    matchValue,
    subjectContains: subject,
    accountEmail,
  }
}

async function handleRulesAdd(context: MailHandlerContext, body: string): Promise<void> {
  const parsed = parseRuleAddArgs(body)
  if (!parsed) {
    await context.responder.reply(
      'Usage: /mail rules add <notify|ignore> <sender|domain> <value> [subject: text] [account: email]',
    )
    return
  }

  try {
    const matchValue = normalizeRuleMatchValue(parsed.matchType, parsed.matchValue)
    const subjectContains = normalizeRuleSubject(parsed.subjectContains)
    let accountId: string | null = null
    let accountEmail: string | null = null
    if (parsed.accountEmail) {
      const account = await findAccountByEmail(context.db, parsed.accountEmail)
      if (!account) {
        await context.responder.reply(`No connected account matches ${parsed.accountEmail}.`)
        return
      }
      accountId = account.id
      accountEmail = account.emailAddress
    }

    await sendRulePreview(context, {
      version: 1,
      action: parsed.action,
      matchType: parsed.matchType,
      matchValue,
      subjectContains,
      accountId,
      accountEmail,
      sourceAccountId: accountId,
      sourceAccountEmail: accountEmail,
      sourceFromEmail: parsed.matchType === 'sender' ? matchValue : null,
      sourceClassificationId: null,
    })
  } catch (error) {
    if (error instanceof RuleValidationError) {
      await context.responder.reply(error.message)
      return
    }
    throw error
  }
}

async function handleRulesCommand(context: MailHandlerContext, body: string): Promise<void> {
  const tokens = body
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  const sub = tokens[0]?.toLowerCase()

  if (sub === 'add') {
    await handleRulesAdd(context, body.slice(tokens[0]?.length ?? 0).trim())
    return
  }

  if (sub === 'disable') {
    const id = tokens[1]
    if (!id || !isUuid(id)) {
      await context.responder.reply('Usage: /mail rules disable <rule-id>')
      return
    }
    const rule = await disableMailRule(context.db, id)
    if (!rule) {
      await context.responder.reply('Rule not found.')
      return
    }
    await context.responder.reply('Rule disabled. It will not affect future mail.')
    return
  }

  const page = parsePage(tokens[0])
  if (page === undefined) {
    await context.responder.reply('Usage: /mail rules [page]')
    return
  }
  await sendRulesPage(context, page)
}

export async function handleMailCommand(text: string, context: MailHandlerContext): Promise<void> {
  const body = text.replace(/^\/mail(?:@\S+)?\s*/i, '').trim()
  const [subRaw] = body.split(/\s+/, 1)
  const sub = (subRaw ?? '').toLowerCase()

  switch (sub) {
    case 'ignored': {
      const page = parsePage(body.slice(subRaw.length).trim() || undefined)
      if (page === undefined) {
        await context.responder.reply('Usage: /mail ignored [page]')
        return
      }
      await sendReview(context, 'ignored', page)
      return
    }
    case 'search': {
      const query = body.slice(subRaw.length).trim()
      if (query.length === 0) {
        await context.responder.reply('Usage: /mail search <text>')
        return
      }
      if (query.length > 200) {
        await context.responder.reply('Search text must be at most 200 characters.')
        return
      }
      await sendReview(context, 'search', 0, query)
      return
    }
    case 'rules': {
      await handleRulesCommand(context, body.slice(subRaw.length).trim())
      return
    }
    case 'status': {
      const summary = await getMailStatusSummary(context.db)
      await context.responder.reply(formatMailStatus(summary))
      return
    }
    default:
      await context.responder.reply(
        sub.length === 0 ? mailHelp() : `Unknown /mail command.\n\n${mailHelp()}`,
      )
  }
}

interface ValidatedClassificationCallback {
  displayed: Awaited<ReturnType<typeof loadDisplayedClassification>>
  notificationId: string | null
}

async function validateClassificationCallback(
  context: MailHandlerContext,
  messageId: number,
  classificationId: string,
): Promise<ValidatedClassificationCallback | { error: string }> {
  const notification = await findNotificationForCallback(context.db, {
    telegramMessageId: messageId,
    classificationId,
  })
  if (notification.conflict) {
    return { error: 'This alert is out of date; use /mail ignored or /mail search again.' }
  }

  if (!notification.notification) {
    const stored = await findOutboundTelegramMessage(context.db, context.chatDbId, messageId)
    const review = readReviewPayload(stored?.payload)
    if (!review?.classificationIds.includes(classificationId)) {
      return { error: 'This item is out of date; run the review again.' }
    }
  }

  const displayed = await loadDisplayedClassification(context.db, classificationId)
  if (!displayed) return { error: 'Mail item not found.' }

  return {
    displayed,
    notificationId: notification.notification?.id ?? null,
  }
}

async function handleFeedbackCallback(
  context: MailHandlerContext,
  messageId: number,
  classificationId: string,
  important: boolean,
): Promise<void> {
  const validated = await validateClassificationCallback(context, messageId, classificationId)
  if ('error' in validated) {
    await context.responder.answerCallback(answerText(validated.error))
    return
  }

  try {
    const result = await applyMessageCorrection(context.db, {
      displayedClassificationId: classificationId,
      runId: context.runId,
      important,
      notificationId: validated.notificationId,
    })

    if (important) {
      const queued = result.notificationOutcomes.some(
        (outcome) => outcome === 'enqueued' || outcome === 'reactivated',
      )
      const duplicate = result.notificationOutcomes.includes('duplicate')
      const sent = result.notificationStatuses.includes('sent')
      const suffix = queued
        ? ' alert queued.'
        : sent
          ? ' an alert was already delivered.'
          : duplicate
            ? ' an alert already exists.'
            : ''
      await context.responder.answerCallback(
        answerText(suffix ? `Marked important;${suffix}` : 'Marked important.'),
      )
    } else {
      const cancelled =
        result.cancelledAlerts > 0
          ? ` cancelled ${result.cancelledAlerts} unsent alert${result.cancelledAlerts === 1 ? '' : 's'}.`
          : ''
      await context.responder.answerCallback(
        answerText(cancelled ? `Marked not important;${cancelled}` : 'Marked not important.'),
      )
    }
  } catch (error) {
    if (error instanceof StaleClassificationError || error instanceof InvalidCorrectionError) {
      await context.responder.answerCallback(answerText(error.message))
      return
    }
    await context.responder.answerCallback('Mail action failed; see worker logs.')
    throw error
  }
}

async function handleCreateRuleCallback(
  context: MailHandlerContext,
  messageId: number,
  classificationId: string,
): Promise<void> {
  const validated = await validateClassificationCallback(context, messageId, classificationId)
  if ('error' in validated) {
    await context.responder.answerCallback(answerText(validated.error))
    return
  }

  const displayed = validated.displayed
  if (!displayed) {
    await context.responder.answerCallback('Mail item not found.')
    return
  }
  if (displayed.classification.supersededAt !== null) {
    await context.responder.answerCallback('This item is out of date; run the review again.')
    return
  }

  try {
    const matchValue = normalizeRuleMatchValue('sender', displayed.message.fromEmail)
    await sendRulePreview(context, {
      version: 1,
      action: displayed.classification.shouldNotify ? 'notify' : 'ignore',
      matchType: 'sender',
      matchValue,
      subjectContains: null,
      accountId: null,
      accountEmail: null,
      sourceAccountId: displayed.account.id,
      sourceAccountEmail: displayed.account.emailAddress,
      sourceFromEmail: displayed.message.fromEmail,
      sourceClassificationId: displayed.classification.id,
    })
    await context.responder.answerCallback('Rule preview created.')
  } catch (error) {
    if (error instanceof RuleValidationError) {
      await context.responder.answerCallback(answerText(error.message))
      return
    }
    await context.responder.answerCallback('Could not create the rule preview.')
    throw error
  }
}

async function loadStoredRuleDraft(
  context: MailHandlerContext,
  messageId: number,
): Promise<StoredRuleDraft | undefined> {
  const stored = await findOutboundTelegramMessage(context.db, context.chatDbId, messageId)
  return readRuleDraftPayload(stored?.payload)
}

async function saveRuleDraft(
  context: MailHandlerContext,
  messageId: number,
  draft: StoredRuleDraft,
): Promise<void> {
  const result = await createMailRule(context.db, {
    action: draft.action,
    matchType: draft.matchType,
    matchValue: draft.matchValue,
    subjectContains: draft.subjectContains,
    accountId: draft.accountId,
  })
  const saved: StoredRuleDraft = { ...draft, savedRuleId: result.rule.id }
  const text = [
    result.created ? 'Rule saved.' : 'Rule already existed; reusing it.',
    `Action: ${saved.action === 'notify' ? 'Notify' : 'Ignore'}`,
    `Match: ${saved.matchType} ${saved.matchValue}`,
    `Subject contains: ${saved.subjectContains ?? '(none)'}`,
    `Scope: ${saved.accountEmail ?? 'All accounts'}`,
    'Applies to future mail only.',
  ].join('\n')
  await context.responder.editMessage(messageId, text, {
    payload: { [MAIL_RULE_DRAFT_PAYLOAD_KEY]: saved },
  })
  await context.responder.answerCallback(result.created ? 'Rule saved.' : 'Rule already existed.')
}

async function handleRuleDraftCallback(
  context: MailHandlerContext,
  messageId: number,
  action: 'rule_save' | 'rule_cancel' | 'rule_action' | 'rule_match' | 'rule_scope',
): Promise<void> {
  const draft = await loadStoredRuleDraft(context, messageId)
  if (!draft) {
    await context.responder.answerCallback('This rule preview is no longer available.')
    return
  }
  if (draft.savedRuleId) {
    await context.responder.answerCallback('Rule already saved.')
    return
  }
  if (draft.cancelled) {
    await context.responder.answerCallback('Rule creation was cancelled.')
    return
  }

  if (action === 'rule_save') {
    try {
      await saveRuleDraft(context, messageId, draft)
    } catch (error) {
      if (error instanceof RuleValidationError) {
        await context.responder.answerCallback(answerText(error.message))
        return
      }
      await context.responder.answerCallback('Could not save the rule.')
      throw error
    }
    return
  }

  if (action === 'rule_cancel') {
    const cancelled: StoredRuleDraft = { ...draft, cancelled: true }
    await context.responder.editMessage(messageId, 'Rule creation cancelled.', {
      payload: { [MAIL_RULE_DRAFT_PAYLOAD_KEY]: cancelled },
    })
    await context.responder.answerCallback('Cancelled.')
    return
  }

  let updated: StoredRuleDraft
  if (action === 'rule_action') {
    updated = { ...draft, action: draft.action === 'notify' ? 'ignore' : 'notify' }
  } else if (action === 'rule_match') {
    if (draft.matchType === 'sender') {
      const domain = domainOf(draft.matchValue)
      if (!domain) {
        await context.responder.answerCallback('Could not derive a domain from this sender.')
        return
      }
      updated = { ...draft, matchType: 'domain', matchValue: domain }
    } else {
      if (!draft.sourceFromEmail) {
        await context.responder.answerCallback('Use /mail rules add to specify a sender address.')
        return
      }
      updated = { ...draft, matchType: 'sender', matchValue: draft.sourceFromEmail.toLowerCase() }
    }
  } else {
    if (draft.accountId !== null) {
      updated = { ...draft, accountId: null, accountEmail: null }
    } else if (draft.sourceAccountId && draft.sourceAccountEmail) {
      updated = {
        ...draft,
        accountId: draft.sourceAccountId,
        accountEmail: draft.sourceAccountEmail,
      }
    } else {
      await context.responder.answerCallback(
        'Use /mail rules add account: <email> to scope a rule.',
      )
      return
    }
  }

  try {
    normalizeRuleMatchValue(updated.matchType, updated.matchValue)
  } catch (error) {
    if (error instanceof RuleValidationError) {
      await context.responder.answerCallback(answerText(error.message))
      return
    }
    throw error
  }

  const rendered = renderRuleDraft(updated)
  await context.responder.editMessage(messageId, rendered.text, {
    buttons: rendered.buttons,
    payload: { [MAIL_RULE_DRAFT_PAYLOAD_KEY]: updated },
  })
  await context.responder.answerCallback()
}

async function handleReviewPageCallback(
  context: MailHandlerContext,
  messageId: number,
  kind: 'ignored' | 'search',
  page: number,
): Promise<void> {
  const stored = await findOutboundTelegramMessage(context.db, context.chatDbId, messageId)
  const review = readReviewPayload(stored?.payload)
  if (!review || review.kind !== kind) {
    await context.responder.answerCallback('This review is out of date; run the command again.')
    return
  }

  const result =
    kind === 'ignored'
      ? await listIgnoredMail(context.db, { page })
      : await searchMail(context.db, { page, query: review.query ?? '' })
  const rendered = renderReviewPage(kind, result, review.query)
  await context.responder.editMessage(messageId, rendered.text, {
    buttons: rendered.buttons,
    payload: rendered.payload,
  })
  await context.responder.answerCallback()
}

async function handleRulesPageCallback(
  context: MailHandlerContext,
  messageId: number,
  page: number,
): Promise<void> {
  const stored = await findOutboundTelegramMessage(context.db, context.chatDbId, messageId)
  const list = readRuleListPayload(stored?.payload)
  if (!list) {
    await context.responder.answerCallback('This rule list is out of date; run /mail rules again.')
    return
  }
  const result = await listRulesPage(context.db, { page })
  const rendered = renderRulesPage(result)
  await context.responder.editMessage(messageId, rendered.text, {
    buttons: rendered.buttons,
    payload: rendered.payload,
  })
  await context.responder.answerCallback()
}

async function handleRuleDisableCallback(
  context: MailHandlerContext,
  messageId: number,
  ruleId: string,
): Promise<void> {
  const stored = await findOutboundTelegramMessage(context.db, context.chatDbId, messageId)
  const list = readRuleListPayload(stored?.payload)
  if (!list?.ruleIds.includes(ruleId)) {
    await context.responder.answerCallback('This rule list is out of date; run /mail rules again.')
    return
  }

  const rule = await disableMailRule(context.db, ruleId)
  if (!rule) {
    await context.responder.answerCallback('Rule not found.')
    return
  }

  let page = list.page
  let result = await listRulesPage(context.db, { page })
  if (result.rules.length === 0 && page > 0) {
    page -= 1
    result = await listRulesPage(context.db, { page })
  }
  const rendered = renderRulesPage(result)
  await context.responder.editMessage(messageId, rendered.text, {
    buttons: rendered.buttons,
    payload: rendered.payload,
  })
  await context.responder.answerCallback('Rule disabled.')
}

export async function handleMailCallback(
  data: string,
  messageId: number | undefined,
  context: MailHandlerContext,
): Promise<void> {
  const callback = parseMailCallback(data)
  if (!callback) {
    await context.responder.answerCallback('Unknown mail action.')
    return
  }
  if (messageId === undefined) {
    await context.responder.answerCallback('This action needs a message context.')
    return
  }

  switch (callback.kind) {
    case 'feedback':
      await handleFeedbackCallback(
        context,
        messageId,
        callback.classificationId,
        callback.important,
      )
      return
    case 'create_rule':
      await handleCreateRuleCallback(context, messageId, callback.classificationId)
      return
    case 'rule_save':
    case 'rule_cancel':
    case 'rule_action':
    case 'rule_match':
    case 'rule_scope':
      await handleRuleDraftCallback(context, messageId, callback.kind)
      return
    case 'rule_disable':
      await handleRuleDisableCallback(context, messageId, callback.ruleId)
      return
    case 'ignored_page':
      await handleReviewPageCallback(context, messageId, 'ignored', callback.page)
      return
    case 'search_page':
      await handleReviewPageCallback(context, messageId, 'search', callback.page)
      return
    case 'rules_page':
      await handleRulesPageCallback(context, messageId, callback.page)
      return
  }
}
