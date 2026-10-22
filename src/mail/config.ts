import { eq, sql } from 'drizzle-orm'
import type { Db, DbSession } from '../db/index.js'
import { companyDomains, vipSenders } from '../db/schema/index.js'
import { normalizeDomain, normalizeEmailAddress } from './normalize.js'

export type CompanyDomainRow = typeof companyDomains.$inferSelect
export type BankSenderRow = typeof vipSenders.$inferSelect

export class MailConfigError extends Error {
  readonly reason: 'not_found'

  constructor(reason: 'not_found', message: string) {
    super(message)
    this.name = 'MailConfigError'
    this.reason = reason
  }
}

export async function listCompanyDomains(
  db: DbSession,
  options: { includeInactive?: boolean } = {},
): Promise<CompanyDomainRow[]> {
  return db
    .select()
    .from(companyDomains)
    .where(options.includeInactive ? undefined : eq(companyDomains.active, true))
    .orderBy(companyDomains.domain)
}

export async function addCompanyDomain(
  db: Db,
  input: { domain: string; label?: string | null; note?: string | null },
): Promise<CompanyDomainRow> {
  const domain = normalizeDomain(input.domain)
  const now = new Date()
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(companyDomains)
      .where(sql`lower(${companyDomains.domain}) = ${domain}`)
      .limit(1)

    if (existing) {
      const [updated] = await tx
        .update(companyDomains)
        .set({
          active: true,
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          updatedAt: now,
        })
        .where(eq(companyDomains.id, existing.id))
        .returning()
      if (!updated) throw new Error('failed to update the company domain')
      return updated
    }

    const [created] = await tx
      .insert(companyDomains)
      .values({
        domain,
        label: input.label ?? null,
        note: input.note ?? null,
        active: true,
      })
      .returning()
    if (!created) throw new Error('failed to insert the company domain')
    return created
  })
}

export async function disableCompanyDomain(
  db: DbSession,
  domain: string,
): Promise<CompanyDomainRow> {
  const normalized = normalizeDomain(domain)
  const [updated] = await db
    .update(companyDomains)
    .set({ active: false, updatedAt: new Date() })
    .where(sql`lower(${companyDomains.domain}) = ${normalized}`)
    .returning()
  if (!updated) {
    throw new MailConfigError('not_found', `company domain ${normalized} was not found`)
  }
  return updated
}

export async function listBankSenders(
  db: DbSession,
  options: { includeInactive?: boolean } = {},
): Promise<BankSenderRow[]> {
  const rows = await db
    .select()
    .from(vipSenders)
    .where(options.includeInactive ? undefined : eq(vipSenders.active, true))
    .orderBy(vipSenders.email)
  return rows
}

export async function addBankSender(
  db: Db,
  input: { email: string; displayName?: string | null; note?: string | null },
): Promise<BankSenderRow> {
  const email = normalizeEmailAddress(input.email)
  const now = new Date()
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(vipSenders)
      .where(sql`lower(${vipSenders.email}) = ${email}`)
      .limit(1)

    if (existing) {
      const [updated] = await tx
        .update(vipSenders)
        .set({
          email,
          active: true,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          updatedAt: now,
        })
        .where(eq(vipSenders.id, existing.id))
        .returning()
      if (!updated) throw new Error('failed to update the bank sender')
      return updated
    }

    const [created] = await tx
      .insert(vipSenders)
      .values({
        email,
        displayName: input.displayName ?? null,
        note: input.note ?? null,
        active: true,
      })
      .returning()
    if (!created) throw new Error('failed to insert the bank sender')
    return created
  })
}

export async function disableBankSender(db: DbSession, email: string): Promise<BankSenderRow> {
  const normalized = normalizeEmailAddress(email)
  const [updated] = await db
    .update(vipSenders)
    .set({ active: false, updatedAt: new Date() })
    .where(sql`lower(${vipSenders.email}) = ${normalized}`)
    .returning()
  if (!updated) {
    throw new MailConfigError('not_found', `bank sender ${normalized} was not found`)
  }
  return updated
}
