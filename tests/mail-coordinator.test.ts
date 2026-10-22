import type { PgBoss } from 'pg-boss'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mailboxSyncState, runs } from '../src/db/schema/index.js'
import { handleMailSyncCoordinatorJob } from '../src/jobs/mail-sync.js'
import { listAccountsDueForSync } from '../src/mail/coordinator.js'
import { QUEUES } from '../src/queue.js'
import { createAccount } from './db/fixtures.js'
import { closeTestDb, db, truncateAllTables } from './db/helpers.js'

beforeEach(truncateAllTables)
afterAll(closeTestDb)

class FakeBoss {
  sent: Array<{ queue: string; data: unknown; options: unknown }> = []
  async send(queue: string, data: unknown, options?: unknown): Promise<string> {
    this.sent.push({ queue, data, options })
    return 'job-id'
  }
}

class PartiallyFailingBoss extends FakeBoss {
  constructor(private readonly failAccountId: string) {
    super()
  }

  override async send(queue: string, data: unknown, options?: unknown): Promise<string> {
    if ((data as { accountId?: string }).accountId === this.failAccountId) {
      throw new Error('queue unavailable')
    }
    return super.send(queue, data, options)
  }
}

describe('mail sync coordinator', () => {
  it('selects only active accounts whose backoff has elapsed', async () => {
    const active = await createAccount({ emailAddress: 'active@example.test' })
    const future = await createAccount({ emailAddress: 'future@example.test' })
    const past = await createAccount({ emailAddress: 'past@example.test' })
    await createAccount({ emailAddress: 'paused@example.test', status: 'paused' })
    await db.insert(mailboxSyncState).values([
      { accountId: future.id, backoffUntil: new Date('2026-10-22T00:00:00Z') },
      { accountId: past.id, backoffUntil: new Date('2026-10-20T00:00:00Z') },
    ])

    const accounts = await listAccountsDueForSync(db, new Date('2026-10-21T00:00:00Z'))
    expect(accounts.map((account) => account.emailAddress)).toEqual([
      'active@example.test',
      'past@example.test',
    ])
    expect(accounts.some((account) => account.id === active.id)).toBe(true)
  })

  it('enqueues one job per due account and records a coordinator run', async () => {
    const active = await createAccount({ emailAddress: 'active@example.test' })
    await createAccount({ emailAddress: 'paused@example.test', status: 'paused' })
    const boss = new FakeBoss()
    const jobId = '11111111-2222-4333-8444-555555555555'

    const result = await handleMailSyncCoordinatorJob({
      jobId,
      data: { source: 'manual' },
      boss: boss as unknown as PgBoss,
    })

    expect(result).toMatchObject({ accounts: 1, enqueued: 1, failed: 0 })
    expect(boss.sent).toHaveLength(1)
    expect(boss.sent[0]).toMatchObject({
      queue: QUEUES.mailSync.name,
      data: { accountId: active.id, source: 'schedule' },
      options: { singletonKey: active.id },
    })

    const [run] = await db.select().from(runs)
    expect(run).toMatchObject({
      kind: 'mail_sync',
      trigger: 'manual',
      status: 'succeeded',
      bossJobId: jobId,
    })
  })

  it('enqueues other accounts when one account enqueue fails', async () => {
    const good = await createAccount({ emailAddress: 'good@example.test' })
    const bad = await createAccount({ emailAddress: 'bad@example.test' })
    const boss = new PartiallyFailingBoss(bad.id)
    const jobId = '22222222-3333-4444-8555-666666666666'

    const result = await handleMailSyncCoordinatorJob({
      jobId,
      data: { source: 'schedule' },
      boss: boss as unknown as PgBoss,
    })

    expect(result).toMatchObject({ accounts: 2, enqueued: 1, failed: 1 })
    expect(boss.sent).toHaveLength(1)
    expect(boss.sent[0]).toMatchObject({
      queue: QUEUES.mailSync.name,
      data: { accountId: good.id, source: 'schedule' },
    })
    const [run] = await db.select().from(runs)
    expect(run).toMatchObject({ kind: 'mail_sync', status: 'succeeded' })
  })
})
