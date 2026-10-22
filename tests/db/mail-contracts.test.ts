import { and, desc, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accounts,
  companyDomains,
  emailClassifications,
  mailboxSyncState,
  mailRules,
  userSettings,
} from '../../src/db/schema/index.js'
import { createAccount, createClassification, createMessage, createRun } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('mail rules', () => {
  it('stores action, exact match, optional subject/account scope, and active default', async () => {
    const account = await createAccount()
    const [rule] = await db
      .insert(mailRules)
      .values({
        action: 'notify',
        matchType: 'sender',
        matchValue: 'boss@example.test',
        subjectContains: 'deadline',
        accountId: account.id,
      })
      .returning()

    expect(rule).toMatchObject({
      action: 'notify',
      matchType: 'sender',
      matchValue: 'boss@example.test',
      subjectContains: 'deadline',
      accountId: account.id,
      active: true,
    })
  })

  it('requires normalized non-empty match values and subject conditions', async () => {
    await expect(
      db.insert(mailRules).values({
        action: 'ignore',
        matchType: 'domain',
        matchValue: 'Example.test',
      }),
    ).rejects.toThrow()

    await expect(
      db.insert(mailRules).values({
        action: 'ignore',
        matchType: 'domain',
        matchValue: 'example.test',
        subjectContains: '   ',
      }),
    ).rejects.toThrow()
  })

  it('deletes scoped rules with their account instead of broadening them', async () => {
    const account = await createAccount()
    await db.insert(mailRules).values({
      action: 'ignore',
      matchType: 'domain',
      matchValue: 'vendor.example.test',
      accountId: account.id,
    })
    expect(await db.select().from(mailRules)).toHaveLength(1)

    await db.delete(accounts).where(eq(accounts.id, account.id))
    expect(await db.select().from(mailRules)).toHaveLength(0)
  })

  it('orders matching active rules by newest edit, then stable id', async () => {
    const newer = await db
      .insert(mailRules)
      .values({
        action: 'notify',
        matchType: 'sender',
        matchValue: 'alerts@example.test',
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      })
      .returning()
    const older = await db
      .insert(mailRules)
      .values({
        action: 'ignore',
        matchType: 'sender',
        matchValue: 'alerts@example.test',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning()
    await db.insert(mailRules).values({
      action: 'ignore',
      matchType: 'sender',
      matchValue: 'alerts@example.test',
      updatedAt: new Date('2026-01-03T00:00:00Z'),
      active: false,
    })

    const rows = await db
      .select()
      .from(mailRules)
      .where(
        and(
          eq(mailRules.active, true),
          eq(mailRules.matchType, 'sender'),
          eq(mailRules.matchValue, 'alerts@example.test'),
        ),
      )
      .orderBy(desc(mailRules.updatedAt), desc(mailRules.id))

    expect(rows.map((row) => row.id)).toEqual([newer[0]?.id, older[0]?.id])
  })
})

describe('company domains', () => {
  it('dedupes case-insensitively and rejects non-normalized input', async () => {
    await db.insert(companyDomains).values({ domain: 'acme.test' })
    await expect(db.insert(companyDomains).values({ domain: 'acme.test' })).rejects.toThrow()
    await expect(db.insert(companyDomains).values({ domain: 'ACME.test' })).rejects.toThrow()
    await expect(db.insert(companyDomains).values({ domain: '' })).rejects.toThrow()
  })
})

describe('classification decision provenance', () => {
  it('stores topic, shouldNotify, summary, source, and actual effort for classifier rows', async () => {
    const account = await createAccount()
    const run = await createRun()
    const message = await createMessage(account.id)
    const [classification] = await db
      .insert(emailClassifications)
      .values({
        messageId: message.id,
        runId: run.id,
        category: 'urgent',
        topic: 'banking',
        shouldNotify: true,
        confidence: '0.870',
        summary: 'A debit posted to the account.',
        reason: 'A successful debit is consequential.',
        decisionSource: 'classifier',
        reasoningEffort: 'high',
        model: 'gpt-test',
        promptVersion: 'prompt-v2',
        classifierVersion: 'policy-v2',
      })
      .returning()

    expect(classification).toMatchObject({
      topic: 'banking',
      shouldNotify: true,
      summary: 'A debit posted to the account.',
      decisionSource: 'classifier',
      reasoningEffort: 'high',
    })
  })

  it('accepts rule decisions with matched-rule provenance and no model snapshot', async () => {
    const account = await createAccount()
    const run = await createRun()
    const message = await createMessage(account.id)
    const [rule] = await db
      .insert(mailRules)
      .values({ action: 'notify', matchType: 'domain', matchValue: 'acme.test' })
      .returning()

    const [classification] = await db
      .insert(emailClassifications)
      .values({
        messageId: message.id,
        runId: run.id,
        topic: 'work',
        shouldNotify: true,
        summary: 'Company announcement.',
        decisionSource: 'rule',
        appliedRuleId: rule.id,
      })
      .returning()

    expect(classification).toMatchObject({
      decisionSource: 'rule',
      appliedRuleId: rule.id,
      category: null,
      model: null,
      confidence: null,
      reasoningEffort: null,
    })
  })

  it('blocks deleting a rule referenced by a past decision', async () => {
    const account = await createAccount()
    const run = await createRun()
    const message = await createMessage(account.id)
    const [rule] = await db
      .insert(mailRules)
      .values({ action: 'notify', matchType: 'domain', matchValue: 'acme.test' })
      .returning()
    await db.insert(emailClassifications).values({
      messageId: message.id,
      runId: run.id,
      decisionSource: 'rule',
      appliedRuleId: rule.id,
    })

    await expect(db.delete(mailRules).where(eq(mailRules.id, rule.id))).rejects.toThrow()

    const [disabled] = await db
      .update(mailRules)
      .set({ active: false })
      .where(eq(mailRules.id, rule.id))
      .returning()
    expect(disabled?.active).toBe(false)
  })

  it('accepts correction decisions without a model or rule', async () => {
    const account = await createAccount()
    const run = await createRun()
    const message = await createMessage(account.id)

    const [classification] = await db
      .insert(emailClassifications)
      .values({
        messageId: message.id,
        runId: run.id,
        topic: 'other',
        shouldNotify: true,
        summary: 'User marked this important.',
        decisionSource: 'correction',
      })
      .returning()

    expect(classification).toMatchObject({
      decisionSource: 'correction',
      appliedRuleId: null,
      category: null,
      model: null,
      confidence: null,
    })
  })

  it('rejects fictitious model fields on rule/correction rows and missing rule provenance', async () => {
    const account = await createAccount()
    const run = await createRun()
    const message = await createMessage(account.id)
    const [rule] = await db
      .insert(mailRules)
      .values({ action: 'ignore', matchType: 'sender', matchValue: 'bulk@example.test' })
      .returning()

    await expect(
      db.insert(emailClassifications).values({
        messageId: message.id,
        runId: run.id,
        decisionSource: 'rule',
        appliedRuleId: rule.id,
        model: 'fictitious-model',
      }),
    ).rejects.toThrow()

    await expect(
      db.insert(emailClassifications).values({
        messageId: message.id,
        runId: run.id,
        decisionSource: 'rule',
      }),
    ).rejects.toThrow()

    await expect(
      db.insert(emailClassifications).values({
        messageId: message.id,
        runId: run.id,
        decisionSource: 'correction',
        confidence: '0.900',
      }),
    ).rejects.toThrow()

    await expect(
      db.insert(emailClassifications).values({
        messageId: message.id,
        runId: run.id,
        decisionSource: 'classifier',
        model: 'gpt-test',
        promptVersion: 'prompt-v1',
        classifierVersion: 'classifier-v1',
        confidence: '0.900',
      }),
    ).rejects.toThrow()
  })

  it('keeps one current classification while appending rule/correction history', async () => {
    const account = await createAccount()
    const run = await createRun()
    const message = await createMessage(account.id)
    const first = await createClassification(message.id, run.id)
    const [rule] = await db
      .insert(mailRules)
      .values({ action: 'notify', matchType: 'domain', matchValue: 'acme.test' })
      .returning()

    await db
      .update(emailClassifications)
      .set({ supersededAt: new Date() })
      .where(eq(emailClassifications.id, first.id))

    const [current] = await db
      .insert(emailClassifications)
      .values({
        messageId: message.id,
        runId: run.id,
        decisionSource: 'rule',
        appliedRuleId: rule.id,
      })
      .returning()

    const rows = await db.select().from(emailClassifications)
    expect(rows).toHaveLength(2)
    const currentRows = rows.filter((row) => row.supersededAt === null)
    expect(currentRows).toHaveLength(1)
    expect(currentRows[0]?.id).toBe(current.id)
  })
})

describe('account connection boundary and mail preferences', () => {
  it('persists the notification boundary across sync state updates', async () => {
    const account = await createAccount()
    const boundary = new Date('2026-10-20T00:00:00Z')
    await db.insert(mailboxSyncState).values({
      accountId: account.id,
      notificationBoundaryAt: boundary,
      historyId: 'history-1',
    })

    await db
      .update(mailboxSyncState)
      .set({ historyId: 'history-2', lastSuccessAt: new Date() })
      .where(eq(mailboxSyncState.accountId, account.id))

    const [sync] = await db
      .select()
      .from(mailboxSyncState)
      .where(eq(mailboxSyncState.accountId, account.id))
    expect(sync?.historyId).toBe('history-2')
    expect(sync?.notificationBoundaryAt?.toISOString()).toBe(boundary.toISOString())
  })

  it('defaults to Asia/Kolkata, no quiet hours or batching, and $1/day', async () => {
    const [settings] = await db.insert(userSettings).values({ id: 1 }).returning()

    expect(settings).toMatchObject({
      timezone: 'Asia/Kolkata',
      quietHoursStart: null,
      quietHoursEnd: null,
      batchWindowMinutes: null,
      dailySpendLimitUsd: '1.00',
    })
  })
})
