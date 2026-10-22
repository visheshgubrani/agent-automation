import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listIgnoredMail, loadDisplayedClassification, searchMail } from '../../src/mail/review.js'
import { createAccount, createClassification, createMessage, createRun } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

describe('ignored mail review', () => {
  it('paginates current ignored mail newest first and excludes important mail', async () => {
    const account = await createAccount()
    const run = await createRun()

    for (let index = 0; index < 7; index += 1) {
      const message = await createMessage(account.id, {
        subject: `Ignored ${index}`,
        receivedAt: new Date(`2026-10-22T0${index}:00:00Z`),
      })
      await createClassification(message.id, run.id, {
        shouldNotify: false,
        summary: `Ignored summary ${index}`,
      })
    }
    const important = await createMessage(account.id, {
      subject: 'Important one',
      receivedAt: new Date('2026-10-22T10:00:00Z'),
    })
    await createClassification(important.id, run.id, { shouldNotify: true })

    const first = await listIgnoredMail(db)
    expect(first.page).toBe(0)
    expect(first.items).toHaveLength(5)
    expect(first.hasNext).toBe(true)
    expect(first.items.map((item) => item.subject)).toEqual([
      'Ignored 6',
      'Ignored 5',
      'Ignored 4',
      'Ignored 3',
      'Ignored 2',
    ])
    expect(first.items.every((item) => item.shouldNotify === false)).toBe(true)
    expect(first.items.every((item) => item.classificationId !== null)).toBe(true)

    const second = await listIgnoredMail(db, { page: 1 })
    expect(second.items.map((item) => item.subject)).toEqual(['Ignored 1', 'Ignored 0'])
    expect(second.hasNext).toBe(false)
  })

  it('returns an empty page beyond the end', async () => {
    const page = await listIgnoredMail(db, { page: 99 })
    expect(page.items).toEqual([])
    expect(page.hasNext).toBe(false)
  })
})

describe('local mail search', () => {
  it('finds subject/body/sender matches in ignored, important, and unclassified mail', async () => {
    const account = await createAccount({ emailAddress: 'work@example.test' })
    const run = await createRun()

    const ignored = await createMessage(account.id, {
      subject: 'Debit alert',
      cleanText: 'Your account was debited INR 500.',
      fromEmail: 'alerts@bank.test',
      receivedAt: new Date('2026-10-22T10:00:00Z'),
    })
    const ignoredClassification = await createClassification(ignored.id, run.id, {
      shouldNotify: false,
    })

    const important = await createMessage(account.id, {
      subject: 'Interview invitation',
      cleanText: 'Please schedule the interview.',
      fromEmail: 'hr@company.test',
      receivedAt: new Date('2026-10-22T11:00:00Z'),
    })
    await createClassification(important.id, run.id, { shouldNotify: true })

    const pending = await createMessage(account.id, {
      subject: 'Unclassified note',
      cleanText: 'A stored message that is still pending.',
      fromEmail: 'friend@example.test',
      receivedAt: new Date('2026-10-22T12:00:00Z'),
    })

    const debit = await searchMail(db, { query: 'debited' })
    expect(debit.items.map((item) => item.messageId)).toEqual([ignored.id])
    expect(debit.items[0]?.classificationId).toBe(ignoredClassification.id)
    expect(debit.items[0]?.shouldNotify).toBe(false)

    const interview = await searchMail(db, { query: 'interview' })
    expect(interview.items.map((item) => item.messageId)).toEqual([important.id])
    expect(interview.items[0]?.shouldNotify).toBe(true)

    const sender = await searchMail(db, { query: 'hr@company' })
    expect(sender.items.map((item) => item.messageId)).toEqual([important.id])

    const unclassified = await searchMail(db, { query: 'pending' })
    expect(unclassified.items.map((item) => item.messageId)).toEqual([pending.id])
    expect(unclassified.items[0]?.classificationId).toBeNull()
    expect(unclassified.items[0]?.shouldNotify).toBeNull()

    const empty = await searchMail(db, { query: 'nothing-matches-this' })
    expect(empty.items).toEqual([])
  })

  it('bounds blank and oversized queries safely', async () => {
    const blank = await searchMail(db, { query: '   ' })
    expect(blank.items).toEqual([])

    const long = await searchMail(db, { query: 'x'.repeat(500) })
    expect(long.items).toEqual([])
  })
})

describe('displayed classification lookup', () => {
  it('returns the classification, message, and receiving account', async () => {
    const account = await createAccount({ emailAddress: 'work@example.test' })
    const run = await createRun()
    const message = await createMessage(account.id, {
      fromEmail: 'alerts@bank.test',
      subject: 'Debit alert',
    })
    const classification = await createClassification(message.id, run.id, {
      shouldNotify: false,
      summary: 'Bank debit',
    })

    const displayed = await loadDisplayedClassification(db, classification.id)
    expect(displayed).toMatchObject({
      classification: {
        id: classification.id,
        shouldNotify: false,
        summary: 'Bank debit',
      },
      message: {
        id: message.id,
        fromEmail: 'alerts@bank.test',
        subject: 'Debit alert',
      },
      account: { id: account.id, emailAddress: 'work@example.test' },
    })
  })
})
