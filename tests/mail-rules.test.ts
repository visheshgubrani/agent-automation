import { describe, expect, it } from 'vitest'
import type { MailRuleRow } from '../src/db/schema/index.js'
import { pickWinningRule, ruleMatchesMessage } from '../src/mail/rules.js'

let nextId = 0

function rule(overrides: Partial<MailRuleRow> = {}): MailRuleRow {
  nextId += 1
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    action: 'notify',
    matchType: 'sender',
    matchValue: 'alerts@example.test',
    subjectContains: null,
    accountId: null,
    active: true,
    createdAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    ...overrides,
  }
}

const message = {
  accountId: '00000000-0000-4000-8000-000000000001',
  fromEmail: 'Alerts@Example.test',
  subject: 'Payment failed',
}

describe('explicit mail rules', () => {
  it('matches an exact sender case-insensitively', () => {
    expect(ruleMatchesMessage(rule(), message)).toBe(true)
    expect(ruleMatchesMessage(rule({ matchValue: 'other@example.test' }), message)).toBe(false)
  })

  it('matches an exact domain and never implies subdomains', () => {
    expect(
      ruleMatchesMessage(rule({ matchType: 'domain', matchValue: 'example.test' }), message),
    ).toBe(true)
    expect(
      ruleMatchesMessage(rule({ matchType: 'domain', matchValue: 'mail.example.test' }), message),
    ).toBe(false)
  })

  it('combines the optional subject condition with AND', () => {
    expect(ruleMatchesMessage(rule({ subjectContains: 'PAYMENT' }), message)).toBe(true)
    expect(ruleMatchesMessage(rule({ subjectContains: 'invoice' }), message)).toBe(false)
  })

  it('honors account scope and inactive rules', () => {
    expect(ruleMatchesMessage(rule({ accountId: message.accountId }), message)).toBe(true)
    expect(
      ruleMatchesMessage(rule({ accountId: '00000000-0000-4000-8000-000000000002' }), message),
    ).toBe(false)
    expect(ruleMatchesMessage(rule({ active: false }), message)).toBe(false)
  })

  it('picks the most recently edited rule from precedence order', () => {
    const newer = rule({ action: 'ignore', updatedAt: new Date('2026-10-22T00:00:00Z') })
    const older = rule({ action: 'notify', updatedAt: new Date('2026-10-21T00:00:00Z') })

    expect(pickWinningRule([newer, older], message)?.id).toBe(newer.id)
  })
})
