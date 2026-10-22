import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { accounts, emailClassifications, messages } from '../../src/db/schema/index.js'
import { createAccount, createClassification, createMessage, createRun } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('idempotent mail ingestion', () => {
  it('rejects a second account with the same email regardless of case', async () => {
    const account = await createAccount({ emailAddress: 'Inbox@Example.test' })
    expect(account.grantedScopes).toEqual([])

    await expect(createAccount({ emailAddress: 'inbox@example.test' })).rejects.toThrow()
  })

  it('rejects a duplicate Gmail message for the same account', async () => {
    const account = await createAccount()
    await createMessage(account.id, { providerMessageId: 'gmail-duplicate' })

    await expect(
      createMessage(account.id, { providerMessageId: 'gmail-duplicate' }),
    ).rejects.toThrow()
  })

  it('allows the same Gmail message id in a different account', async () => {
    const first = await createAccount()
    const second = await createAccount()
    await createMessage(first.id, { providerMessageId: 'gmail-same' })
    const other = await createMessage(second.id, { providerMessageId: 'gmail-same' })

    expect(other.accountId).toBe(second.id)
  })

  it('rejects invalid triage status values at the database boundary', async () => {
    await expect(
      db.insert(accounts).values({
        provider: 'gmail',
        emailAddress: 'bad-status@example.test',
        status: 'bogus' as never,
      }),
    ).rejects.toThrow()
  })

  it('searches cleaned email text with the FTS expression used by the index', async () => {
    const account = await createAccount()
    await createMessage(account.id, {
      subject: 'Quarterly invoice',
      cleanText: 'The Acme invoice is attached and urgent',
    })

    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        sql`to_tsvector('english', coalesce(${messages.subject}, '') || ' ' || ${messages.cleanText}) @@ websearch_to_tsquery('english', ${'acme invoice'})`,
      )

    expect(rows).toHaveLength(1)
  })
})

describe('classification history', () => {
  it('keeps exactly one current classification and allows superseding it', async () => {
    const account = await createAccount()
    const run = await createRun()
    const message = await createMessage(account.id)

    const first = await createClassification(message.id, run.id)
    await expect(createClassification(message.id, run.id)).rejects.toThrow()

    await db
      .update(emailClassifications)
      .set({ supersededAt: sql`now()` })
      .where(eq(emailClassifications.id, first.id))

    const second = await createClassification(message.id, run.id, { category: 'urgent' })
    expect(second.id).not.toBe(first.id)
    expect(second.category).toBe('urgent')
  })

  it('rejects a confidence outside 0..1', async () => {
    const account = await createAccount()
    const run = await createRun()
    const message = await createMessage(account.id)

    await expect(
      createClassification(message.id, run.id, { confidence: '1.500' }),
    ).rejects.toThrow()
  })
})
