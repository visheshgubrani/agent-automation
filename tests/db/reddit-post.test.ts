import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { approveApproval } from '../../src/agent/approvals.js'
import type { AgentConfig } from '../../src/config.js'
import {
  approvals,
  browserTasks,
  llmCalls,
  notificationOutbox,
  toolCalls,
} from '../../src/db/schema/index.js'
import { handleAgentIntakeJob } from '../../src/jobs/agent-intake.js'
import { handleBrowserTaskJob } from '../../src/jobs/browser-task.js'
import { createBudgetedModel } from '../../src/llm/budgeted-model.js'
import {
  FakeBrowserDriver,
  FakeBrowserPage,
  type FakePageModel,
  POST_URL,
  redditPostComposer,
} from '../fakes/browser.js'
import { scriptedModel, textResult, toolCallResult } from '../fakes/model.js'
import { createTelegramMessage } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const TITLE = 'Exact title, with "quotes" 🙂'
const BODY = 'A drafted body.\nSecond line.'
const dirs: string[] = []
beforeEach(truncateAllTables)
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await closeTestDb()
})
async function waitUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await sleep(20)
  }
  throw new Error('condition timed out')
}

async function startPost(
  options: {
    tamper?: 'before_approval' | 'after_approval'
    wrongComposer?: boolean
    wrongResultCommunity?: boolean
  } = {},
) {
  const artifactDir = await mkdtemp(join(tmpdir(), 'post-job-'))
  dirs.push(artifactDir)
  const agent: AgentConfig = {
    openaiApiKey: 'test-key',
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    maxSteps: 10,
    maxOutputTokens: 1_000,
    stepTimeoutMs: 30_000,
    taskMaxUsd: 0.5,
    browser: {
      cdpUrl: 'http://127.0.0.1:9222',
      viewUrl: 'https://box.tail1234.ts.net/',
      artifactDir,
      handoffTimeoutMinutes: 15,
      approvalTimeoutMinutes: 30,
    },
  }
  const boss = { send: async () => 'job-id' } as unknown as PgBoss
  const message = await createTelegramMessage({
    text: `Post to r/test with title:\n${TITLE}\nDraft a short body about code review.`,
  })
  await handleAgentIntakeJob({
    db,
    boss,
    agent,
    jobId: '11111111-2222-4333-8444-555555555555',
    data: { telegramMessageId: message.id },
    model: scriptedModel([
      textResult(
        JSON.stringify({
          kind: 'one_off',
          site: 'reddit',
          action: 'reddit_post',
          targetUrl: POST_URL,
          fields: [
            { key: 'post_title', value: TITLE, provenance: 'user_verbatim' },
            { key: 'post_body', value: BODY, provenance: 'drafted' },
          ],
          cron: null,
          question: null,
        }),
      ),
    ]),
  })
  const [task] = await db.select().from(browserTasks)
  if (!task) throw new Error('intake did not create task')
  let bodyReads = 0
  const composer = (): FakePageModel => {
    const model = redditPostComposer({
      onPost: () => ({
        url: `https://www.reddit.com/r/${options.wrongResultCommunity ? 'other' : 'test'}/comments/new123/title/`,
        title: TITLE,
        snapshot: `- heading "${TITLE}" [level=1] [ref=e1]\n- paragraph [ref=e2]: ${BODY}`,
      }),
      readBack: (ref, value) => {
        if (ref === 'e21') {
          bodyReads++
          if (
            options.tamper === 'before_approval' ||
            (options.tamper === 'after_approval' && bodyReads >= 2)
          )
            return `${value} changed`
        }
        return value ?? ''
      },
    })
    if (options.wrongComposer) model.url = 'https://www.reddit.com/r/other/submit'
    return model
  }
  const page = new FakeBrowserPage(composer(), { [POST_URL]: composer })
  const driver = new FakeBrowserDriver(() => page)
  const controller = new AbortController()
  const script = [
    toolCallResult('navigate', { url: POST_URL }),
    toolCallResult('click', { ref: '1:e22' }), // A model never gets to click Post.
    toolCallResult('fill_field', { ref: '1:e20', fieldKey: 'post_title' }),
    toolCallResult('snapshot', {}),
    toolCallResult('fill_field', { ref: '2:e21', fieldKey: 'post_body' }),
    toolCallResult('snapshot', {}),
    toolCallResult('request_submit_approval', {
      submitRef: '3:e22',
      fieldRefs: { post_title: '3:e20', post_body: '3:e21' },
    }),
    toolCallResult('report_result', { summary: 'could not prepare the form' }),
  ]
  const promise = handleBrowserTaskJob({
    db,
    boss,
    agent,
    jobId: '66666666-7777-4888-8999-000000000000',
    data: { taskId: task.id },
    driver,
    signal: controller.signal,
    modelFactory: (runId) =>
      createBudgetedModel(scriptedModel(script), {
        db,
        runId,
        purpose: 'agent_browser_step',
        model: agent.model,
        maxOutputTokens: 1_000,
        taskMaxUsd: 0.5,
      }),
  })
  return { task, page, driver, promise, controller }
}

describe('Reddit text posts', () => {
  it('pins title/body from intake, shows exact multi-field approval, refuses model Post clicks, and submits once without further model calls', async () => {
    const h = await startPost()
    try {
      await waitUntil(async () => (await db.select().from(approvals)).length === 1)
      const [approval] = await db.select().from(approvals)
      if (!approval) throw new Error('missing approval')
      const [card] = await db
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.approvalId, approval.id))
      expect(card?.body).toContain('Subreddit: r/test')
      expect(card?.body).toContain(`Title (verbatim):\n${TITLE}`)
      expect(card?.body).toContain(`Body (drafted):\n${BODY}`)
      expect(approval.payload.fields).toMatchObject([
        { key: 'post_title', value: TITLE },
        { key: 'post_body', value: BODY, provenance: 'drafted' },
      ])
      const refused = await db
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.toolName, 'browser.click'))
      expect(refused[0]?.status).toBe('failed')
      expect(h.page.actions.filter((action) => action.type === 'click')).toHaveLength(0)
      const callsBefore = await db.select().from(llmCalls)
      await approveApproval(db, { approvalId: approval.id, resolverRef: 'test' })
      expect(await h.promise).toMatchObject({ status: 'succeeded' })
      expect(h.page.actions.filter((action) => action.type === 'click')).toEqual([
        { type: 'click', ref: 'e22' },
      ])
      expect(await db.select().from(llmCalls)).toHaveLength(callsBefore.length)
      expect(await db.select().from(toolCalls).where(eq(toolCalls.riskTier, 'send'))).toHaveLength(
        1,
      )
    } finally {
      h.controller.abort()
      await h.promise
    }
  })

  it('a mismatched body prevents multi-field approval and any click', async () => {
    const h = await startPost({ tamper: 'before_approval' })
    try {
      expect(await h.promise).toMatchObject({
        status: 'failed',
        statusReason: 'precondition_failed',
      })
      expect(await db.select().from(approvals)).toHaveLength(0)
      expect(h.page.actions.filter((action) => action.type === 'click')).toHaveLength(0)
      const [attempt] = await db
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.toolName, 'browser.request_submit_approval'))
      expect(attempt?.error).toContain('post_body')
    } finally {
      h.controller.abort()
      await h.promise
    }
  })

  it('a changed body after approval prevents the submit click', async () => {
    const h = await startPost({ tamper: 'after_approval' })
    try {
      await waitUntil(async () => (await db.select().from(approvals)).length === 1)
      const [approval] = await db.select().from(approvals)
      if (!approval) throw new Error('missing approval')
      await approveApproval(db, { approvalId: approval.id, resolverRef: 'test' })
      expect(await h.promise).toMatchObject({
        status: 'failed',
        statusReason: 'precondition_failed',
      })
      expect(h.page.actions.filter((action) => action.type === 'click')).toHaveLength(0)
    } finally {
      h.controller.abort()
      await h.promise
    }
  })

  it('a composer in a different subreddit cannot request approval', async () => {
    const h = await startPost({ wrongComposer: true })
    try {
      expect(await h.promise).toMatchObject({ status: 'failed' })
      expect(await db.select().from(approvals)).toHaveLength(0)
      const [attempt] = await db
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.toolName, 'browser.request_submit_approval'))
      expect(attempt?.error).toContain('requested subreddit')
    } finally {
      h.controller.abort()
      await h.promise
    }
  })

  it('a post URL in another subreddit is reported unverified', async () => {
    const h = await startPost({ wrongResultCommunity: true })
    try {
      await waitUntil(async () => (await db.select().from(approvals)).length === 1)
      const [approval] = await db.select().from(approvals)
      if (!approval) throw new Error('missing approval')
      await approveApproval(db, { approvalId: approval.id, resolverRef: 'test' })
      expect(await h.promise).toMatchObject({ status: 'unverified' })
    } finally {
      h.controller.abort()
      await h.promise
    }
  })
})
