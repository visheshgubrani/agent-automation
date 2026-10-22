import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createMailRule,
  disableMailRule,
  listRulesPage,
  normalizeRuleMatchValue,
  normalizeRuleSubject,
  RuleValidationError,
} from '../../src/mail/rules-admin.js'
import { createAccount } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('rule input validation', () => {
  it('normalizes sender and domain values and rejects malformed input', () => {
    expect(normalizeRuleMatchValue('sender', '  User@Example.Test ')).toBe('user@example.test')
    expect(normalizeRuleMatchValue('domain', ' Example.Test ')).toBe('example.test')
    expect(() => normalizeRuleMatchValue('sender', 'not-an-email')).toThrow(RuleValidationError)
    expect(() => normalizeRuleMatchValue('domain', 'user@example.test')).toThrow(
      RuleValidationError,
    )
    expect(normalizeRuleSubject('  invoice  ')).toBe('invoice')
    expect(normalizeRuleSubject('   ')).toBeNull()
    expect(() => normalizeRuleSubject('x'.repeat(201))).toThrow(RuleValidationError)
  })
})

describe('rule management', () => {
  it('reuses an identical active rule instead of duplicating it', async () => {
    const first = await createMailRule(db, {
      action: 'notify',
      matchType: 'sender',
      matchValue: 'User@Example.Test',
      subjectContains: 'invoice',
    })
    expect(first.created).toBe(true)
    expect(first.rule).toMatchObject({
      action: 'notify',
      matchType: 'sender',
      matchValue: 'user@example.test',
      subjectContains: 'invoice',
      active: true,
    })

    const second = await createMailRule(db, {
      action: 'notify',
      matchType: 'sender',
      matchValue: 'user@example.test',
      subjectContains: 'invoice',
    })
    expect(second.created).toBe(false)
    expect(second.rule.id).toBe(first.rule.id)
  })

  it('lists active rules with account scope, newest edit first, and paginates', async () => {
    const account = await createAccount({ emailAddress: 'work@example.test' })
    for (let index = 0; index < 6; index += 1) {
      await createMailRule(db, {
        action: index % 2 === 0 ? 'notify' : 'ignore',
        matchType: 'domain',
        matchValue: `domain-${index}.test`,
        accountId: index === 5 ? account.id : null,
      })
    }

    const first = await listRulesPage(db)
    expect(first.rules).toHaveLength(5)
    expect(first.hasNext).toBe(true)
    expect(first.rules[0]?.matchValue).toBe('domain-5.test')
    expect(first.rules[0]?.accountEmail).toBe('work@example.test')

    const second = await listRulesPage(db, { page: 1 })
    expect(second.rules).toHaveLength(1)
    expect(second.hasNext).toBe(false)
  })

  it('disables a rule without deleting its history', async () => {
    const created = await createMailRule(db, {
      action: 'ignore',
      matchType: 'sender',
      matchValue: 'noise@example.test',
    })

    const disabled = await disableMailRule(db, created.rule.id)
    expect(disabled).toMatchObject({ id: created.rule.id, active: false })
    expect((await listRulesPage(db)).rules).toHaveLength(0)
  })
})
