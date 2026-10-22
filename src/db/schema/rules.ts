import { sql } from 'drizzle-orm'
import { boolean, check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { accounts } from './accounts.js'
import { mailRuleAction, mailRuleMatchType } from './enums.js'
import { timestamps } from './types.js'

/**
 * Explicit user notification rules. They apply to future processing only; a message
 * correction never creates one silently. Values are stored normalized (lowercase, trimmed);
 * match conditions combine with AND and are evaluated case-insensitively by the app.
 *
 * Precedence is message correction → explicit rule → classifier. When several rules match,
 * the most recently edited active rule wins, with `id` as the stable tie-breaker.
 */
export const mailRules = pgTable(
  'mail_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: mailRuleAction('action').notNull(),
    matchType: mailRuleMatchType('match_type').notNull(),
    // Exact sender address or exact domain; domains do not include subdomains.
    matchValue: text('match_value').notNull(),
    // Optional case-insensitive substring condition on the subject.
    subjectContains: text('subject_contains'),
    // Null scope means all connected accounts. Deleting a scoped account deletes its rules
    // instead of silently broadening them to every inbox.
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    check(
      'mail_rules_match_value_check',
      sql`${t.matchValue} = lower(btrim(${t.matchValue})) and length(${t.matchValue}) > 0`,
    ),
    check(
      'mail_rules_subject_contains_check',
      sql`${t.subjectContains} is null or length(btrim(${t.subjectContains})) > 0`,
    ),
    // Rule evaluation: active rules matching a sender/domain; newest edit wins.
    index('mail_rules_match_idx')
      .on(t.matchType, t.matchValue, t.updatedAt.desc(), t.id.desc())
      .where(sql`${t.active}`),
    index('mail_rules_account_idx').on(t.accountId).where(sql`${t.accountId} is not null`),
  ],
)

/**
 * Company domains help the classifier distinguish work mail from bulk mail. Domains are
 * normalized lowercase and unique case-insensitively; they are configuration, not rules.
 */
export const companyDomains = pgTable(
  'company_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    domain: text('domain').notNull(),
    label: text('label'),
    note: text('note'),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('company_domains_domain_lower_uq').on(sql`lower(${t.domain})`),
    check(
      'company_domains_domain_check',
      sql`${t.domain} = lower(btrim(${t.domain})) and length(${t.domain}) > 0`,
    ),
  ],
)

export type MailRuleRow = typeof mailRules.$inferSelect
export type CompanyDomainRow = typeof companyDomains.$inferSelect
