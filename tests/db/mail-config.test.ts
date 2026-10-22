import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { companyDomains, vipSenders } from '../../src/db/schema/index.js'
import {
  addBankSender,
  addCompanyDomain,
  disableBankSender,
  disableCompanyDomain,
  listBankSenders,
  listCompanyDomains,
  MailConfigError,
} from '../../src/mail/config.js'
import { normalizeDomain, normalizeEmailAddress } from '../../src/mail/normalize.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('mail directory normalization', () => {
  it('normalizes valid addresses/domains and rejects malformed values', () => {
    expect(normalizeEmailAddress('  Bank@Example.Test ')).toBe('bank@example.test')
    expect(normalizeDomain('  Acme.Test ')).toBe('acme.test')

    expect(() => normalizeEmailAddress('not-an-address')).toThrow(/invalid email/)
    expect(() => normalizeEmailAddress('a@b')).toThrow(/invalid email/)
    expect(() => normalizeDomain('no-dot')).toThrow(/invalid domain/)
    expect(() => normalizeDomain('user@example.test')).toThrow(/invalid domain/)
    expect(() => normalizeDomain('a..test')).toThrow(/invalid domain/)
  })
})

describe('company domains', () => {
  it('adds, upserts, lists, and disables case-insensitively', async () => {
    const created = await addCompanyDomain(db, { domain: 'Acme.Test', label: 'Acme' })
    expect(created).toMatchObject({ domain: 'acme.test', label: 'Acme', active: true })

    const updated = await addCompanyDomain(db, { domain: 'ACME.TEST', note: 'work mail' })
    expect(updated.id).toBe(created.id)
    expect(updated.active).toBe(true)
    expect(updated.label).toBe('Acme')
    expect(updated.note).toBe('work mail')

    expect(await listCompanyDomains(db)).toHaveLength(1)
    const disabled = await disableCompanyDomain(db, 'acme.test')
    expect(disabled.active).toBe(false)
    expect(await listCompanyDomains(db)).toHaveLength(0)
    expect(await listCompanyDomains(db, { includeInactive: true })).toHaveLength(1)

    await expect(disableCompanyDomain(db, 'missing.test')).rejects.toBeInstanceOf(MailConfigError)
  })

  it('rejects invalid domains without writing rows', async () => {
    await expect(addCompanyDomain(db, { domain: 'not a domain' })).rejects.toThrow(/invalid domain/)
    expect(await db.select().from(companyDomains)).toHaveLength(0)
  })
})

describe('bank senders', () => {
  it('adds, upserts, lists, and disables known senders case-insensitively', async () => {
    const created = await addBankSender(db, {
      email: 'Bank@Example.Test',
      displayName: 'Example Bank',
    })
    expect(created).toMatchObject({
      email: 'bank@example.test',
      displayName: 'Example Bank',
      active: true,
    })

    const updated = await addBankSender(db, { email: 'BANK@example.test', note: 'alerts' })
    expect(updated.id).toBe(created.id)
    expect(updated.displayName).toBe('Example Bank')
    expect(updated.note).toBe('alerts')

    expect(await listBankSenders(db)).toHaveLength(1)
    const disabled = await disableBankSender(db, 'bank@example.test')
    expect(disabled.active).toBe(false)
    expect(await listBankSenders(db)).toHaveLength(0)
    expect(await listBankSenders(db, { includeInactive: true })).toHaveLength(1)

    await expect(disableBankSender(db, 'missing@example.test')).rejects.toBeInstanceOf(
      MailConfigError,
    )
  })

  it('rejects invalid addresses without writing rows', async () => {
    await expect(addBankSender(db, { email: 'not-an-email' })).rejects.toThrow(/invalid email/)
    expect(await db.select().from(vipSenders)).toHaveLength(0)
  })
})
