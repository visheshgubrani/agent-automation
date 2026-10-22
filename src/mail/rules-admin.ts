import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { DbSession } from '../db/index.js'
import { accounts, type MailRuleRow, mailRules } from '../db/schema/index.js'

export const RULE_PAGE_SIZE = 5
const MAX_PAGE = 10_000

export type RuleAction = 'notify' | 'ignore'
export type RuleMatchType = 'sender' | 'domain'

export interface RuleInput {
  action: RuleAction
  matchType: RuleMatchType
  matchValue: string
  subjectContains?: string | null
  accountId?: string | null
}

export interface RuleDisplay extends MailRuleRow {
  accountEmail: string | null
}

export interface RulePage {
  rules: RuleDisplay[]
  page: number
  hasNext: boolean
}

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleValidationError'
  }
}

export function clampRulePage(page: number): number {
  if (!Number.isFinite(page)) return 0
  return Math.max(0, Math.min(MAX_PAGE, Math.trunc(page)))
}

export function normalizeRuleMatchValue(matchType: RuleMatchType, raw: string): string {
  const value = raw.trim().toLowerCase()
  if (matchType === 'sender') {
    if (!/^[^\s@]+@[^\s@]+$/.test(value)) {
      throw new RuleValidationError('sender must be an exact email address')
    }
    return value
  }

  if (
    value.length === 0 ||
    value.includes('@') ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
  ) {
    throw new RuleValidationError('domain must be an exact lowercase domain')
  }
  return value
}

export function normalizeRuleSubject(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim()
  if (value.length === 0) return null
  if (value.length > 200) {
    throw new RuleValidationError('subject condition must be at most 200 characters')
  }
  return value
}

export interface CreateRuleResult {
  rule: MailRuleRow
  created: boolean
}

/**
 * Create an explicit future rule. Identical active rules are reused so repeated saves/commands
 * cannot accumulate duplicates; disabled history is retained.
 */
export async function createMailRule(
  db: DbSession,
  input: RuleInput,
  now: Date = new Date(),
): Promise<CreateRuleResult> {
  const matchValue = normalizeRuleMatchValue(input.matchType, input.matchValue)
  const subjectContains = normalizeRuleSubject(input.subjectContains)
  const accountId = input.accountId ?? null

  const [existing] = await db
    .select()
    .from(mailRules)
    .where(
      and(
        eq(mailRules.active, true),
        eq(mailRules.action, input.action),
        eq(mailRules.matchType, input.matchType),
        eq(mailRules.matchValue, matchValue),
        subjectContains === null
          ? isNull(mailRules.subjectContains)
          : eq(mailRules.subjectContains, subjectContains),
        accountId === null ? isNull(mailRules.accountId) : eq(mailRules.accountId, accountId),
      ),
    )
    .limit(1)
  if (existing) {
    return { rule: existing, created: false }
  }

  const [rule] = await db
    .insert(mailRules)
    .values({
      action: input.action,
      matchType: input.matchType,
      matchValue,
      subjectContains,
      accountId,
      active: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!rule) throw new Error('failed to insert the mail rule')
  return { rule, created: true }
}

/** Active rules for the Telegram list, newest edit first, with the scoped account address. */
export async function listRulesPage(
  db: DbSession,
  options: { page?: number; pageSize?: number } = {},
): Promise<RulePage> {
  const pageSize = Math.max(1, Math.min(10, Math.trunc(options.pageSize ?? RULE_PAGE_SIZE)))
  const page = clampRulePage(options.page ?? 0)

  const rows = await db
    .select({
      id: mailRules.id,
      action: mailRules.action,
      matchType: mailRules.matchType,
      matchValue: mailRules.matchValue,
      subjectContains: mailRules.subjectContains,
      accountId: mailRules.accountId,
      active: mailRules.active,
      createdAt: mailRules.createdAt,
      updatedAt: mailRules.updatedAt,
      accountEmail: sql<string | null>`${accounts.emailAddress}`,
    })
    .from(mailRules)
    .leftJoin(accounts, eq(accounts.id, mailRules.accountId))
    .where(eq(mailRules.active, true))
    .orderBy(desc(mailRules.updatedAt), desc(mailRules.id))
    .limit(pageSize + 1)
    .offset(page * pageSize)

  return {
    rules: rows.slice(0, pageSize),
    page,
    hasNext: rows.length > pageSize,
  }
}

export async function getMailRule(db: DbSession, id: string): Promise<MailRuleRow | undefined> {
  const [rule] = await db.select().from(mailRules).where(eq(mailRules.id, id)).limit(1)
  return rule
}

/** Disable a rule without deleting it; past classification provenance keeps the FK. */
export async function disableMailRule(
  db: DbSession,
  id: string,
  now: Date = new Date(),
): Promise<MailRuleRow | undefined> {
  const [rule] = await db
    .update(mailRules)
    .set({ active: false, updatedAt: now })
    .where(eq(mailRules.id, id))
    .returning()
  return rule
}
