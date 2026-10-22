import { desc, eq } from 'drizzle-orm'
import type { DbSession } from '../db/index.js'
import { type MailRuleRow, mailRules } from '../db/schema/index.js'

export interface RuleMatchMessage {
  accountId: string
  fromEmail: string
  subject: string
}

function senderDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1)
}

/**
 * Match one rule against a message. Values are compared case-insensitively; a domain match is
 * exact (no subdomains), and all conditions combine with AND.
 */
export function ruleMatchesMessage(rule: MailRuleRow, message: RuleMatchMessage): boolean {
  if (!rule.active) return false
  if (rule.accountId !== null && rule.accountId !== message.accountId) return false

  const fromEmail = message.fromEmail.trim().toLowerCase()
  const matchesSender =
    rule.matchType === 'sender'
      ? fromEmail === rule.matchValue
      : senderDomain(fromEmail) === rule.matchValue
  if (!matchesSender) return false

  if (rule.subjectContains !== null) {
    return message.subject.toLowerCase().includes(rule.subjectContains.trim().toLowerCase())
  }
  return true
}

/**
 * Precedence inside explicit rules: most recently edited active rule wins, with id DESC as the
 * stable tie-breaker. `rules` must already be in that order (loadActiveRules does it).
 */
export function pickWinningRule(
  rules: readonly MailRuleRow[],
  message: RuleMatchMessage,
): MailRuleRow | undefined {
  return rules.find((rule) => ruleMatchesMessage(rule, message))
}

/** Active rules in deterministic precedence order; tiny table, one query per triage pass. */
export async function loadActiveRules(db: DbSession): Promise<MailRuleRow[]> {
  return db
    .select()
    .from(mailRules)
    .where(eq(mailRules.active, true))
    .orderBy(desc(mailRules.updatedAt), desc(mailRules.id))
}
