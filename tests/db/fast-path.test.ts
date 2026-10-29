import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runFastPath, runFastPathThenAgent } from '../../src/agent/browser-controller.js'
import {
  type ApprovalOutcome,
  BrowserToolbox,
  type BrowserToolHooks,
  type HumanOutcome,
} from '../../src/agent/browser-tools.js'
import type {
  BrowserSubmitApprovalPayloadV1,
  BrowserTaskSpecV1,
} from '../../src/agent/contracts.js'
import { getSiteAction, type SiteAction } from '../../src/browser/sites.js'
import type { AgentConfig } from '../../src/config.js'
import { llmCalls, toolCalls } from '../../src/db/schema/index.js'
import { createBudgetedModel } from '../../src/llm/budgeted-model.js'
import {
  challengePage,
  FakeBrowserPage,
  type FakePageModel,
  POST_URL,
  redditComposer,
  redditHydratingThread,
  redditLongThread,
  redditPostComposer,
  redditThread,
  THREAD_URL,
} from '../fakes/browser.js'
import { scriptedModel, toolCallResult } from '../fakes/model.js'
import { createBrowserTask, createRun } from './fixtures.js'
import { closeTestDb, db, truncateAllTables } from './helpers.js'

const tempDirs: string[] = []
beforeEach(truncateAllTables)
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  await closeTestDb()
})

const COMMENT = 'SENTINEL-COMMENT exact words 🙂'
const JOB_URL = 'https://www.workatastartup.com/jobs/12345'

function siteAction(site: string, key: string) {
  const found = getSiteAction(site, key)
  if (!found) throw new Error(`${key} must be registered`)
  return found
}

const commentSpec = (): BrowserTaskSpecV1 => ({
  version: 1,
  targetUrl: THREAD_URL,
  fields: [{ key: 'comment_text', value: COMMENT, provenance: 'user_verbatim' }],
})

interface Harness {
  action: SiteAction
  toolbox: BrowserToolbox
  page: FakeBrowserPage
  runId: string
  spec: BrowserTaskSpecV1
  approvals: BrowserSubmitApprovalPayloadV1[]
  handoffs: Parameters<BrowserToolHooks['requestHuman']>[0][]
  composed: number
}

async function harness(
  options: {
    site?: string
    action?: string
    spec?: BrowserTaskSpecV1
    start?: FakePageModel
    routes?: Record<string, () => FakePageModel>
    human?: (page: FakeBrowserPage) => Promise<HumanOutcome>
    approval?: ApprovalOutcome
    compose?: () => Promise<BrowserTaskSpecV1 | undefined>
    note?: string
  } = {},
): Promise<Harness> {
  const { site, action } = siteAction(options.site ?? 'reddit', options.action ?? 'reddit_comment')
  const spec = options.spec ?? commentSpec()
  const run = await createRun({ kind: 'browser_task', trigger: 'telegram' })
  const task = await createBrowserTask({
    runId: run.id,
    status: 'running',
    site: site.key,
    action: action.key,
    targetUrl: spec.targetUrl,
    spec,
  })
  const artifactDir = await mkdtemp(join(tmpdir(), 'fast-path-'))
  tempDirs.push(artifactDir)
  const page = new FakeBrowserPage(
    options.start ?? { url: 'about:blank', snapshot: '- main [ref=e1]' },
    options.routes ?? { [THREAD_URL]: redditThread },
  )
  const h: Harness = {
    action,
    page,
    runId: run.id,
    spec,
    approvals: [],
    handoffs: [],
    composed: 0,
    toolbox: undefined as unknown as BrowserToolbox,
  }
  h.toolbox = new BrowserToolbox({
    db,
    runId: run.id,
    taskId: task.id,
    site,
    action,
    spec,
    page,
    artifactDir,
    hooks: {
      composeComment: async () => {
        h.composed += 1
        return options.compose?.()
      },
      composeNote: async () => {
        h.composed += 1
        return {
          version: 1,
          targetUrl: spec.targetUrl,
          fields: [
            { key: 'application_note', value: options.note ?? 'A note.', provenance: 'drafted' },
          ],
        }
      },
      requestHuman: async (input) => {
        h.handoffs.push(input)
        return options.human ? options.human(page) : 'resolved'
      },
      requestSubmitApproval: async (payload) => {
        h.approvals.push(payload)
        return options.approval ?? 'approved'
      },
    },
    now: () => new Date('2026-10-28T10:00:00Z'),
  })
  return h
}

function fastPath(h: Harness, signals: { shutdown?: AbortSignal; cancel?: AbortSignal } = {}) {
  return runFastPath({
    toolbox: h.toolbox,
    action: h.action,
    spec: h.spec,
    ...(signals.shutdown ? { shutdownSignal: signals.shutdown } : {}),
    ...(signals.cancel ? { taskCancelSignal: signals.cancel } : {}),
  })
}

const calls = (runId: string) =>
  db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).orderBy(asc(toolCalls.startedAt))

const clicks = (page: FakeBrowserPage) =>
  page.actions.filter((action) => action.type === 'click').map((action) => action.ref)

describe('fast path preparation', () => {
  it('opens the Reddit composer, fills the exact text and requests approval without a model', async () => {
    const h = await harness()
    const outcome = await fastPath(h)

    expect(outcome).toEqual({
      end: 'approval_requested',
      actions: 3,
      trail: ['click_opener button', 'fill_field comment_text', 'request_submit_approval'],
    })
    expect(h.approvals).toHaveLength(1)
    expect(h.approvals[0]?.fields).toEqual([
      expect.objectContaining({ key: 'comment_text', value: COMMENT }),
    ])
    expect(clicks(h.page)).toEqual(['e8'])
    expect(h.page.actions.filter((action) => action.type === 'goto')).toHaveLength(1)

    const rows = await calls(h.runId)
    expect(rows.map((row) => row.toolName)).toEqual([
      'browser.navigate',
      'browser.click',
      'browser.composer_check',
      'browser.composer_check',
      'browser.fill_field',
      'browser.snapshot',
      'browser.composer_check',
      'browser.composer_check',
      'browser.request_submit_approval',
    ])
    // Values travel only in the approval payload, never in the outcome or audit args.
    expect(JSON.stringify(outcome)).not.toContain('SENTINEL')
    expect(JSON.stringify(rows.map((row) => row.args))).not.toContain('SENTINEL')
    expect(await db.select().from(llmCalls)).toHaveLength(0)
  })

  it('waits out Reddit hydration and opens the real composer, never the stale placeholder', async () => {
    const h = await harness({ routes: { [THREAD_URL]: redditHydratingThread } })
    const outcome = await fastPath(h)

    expect(outcome).toEqual({
      end: 'approval_requested',
      actions: 3,
      trail: ['click_opener textbox', 'fill_field comment_text', 'request_submit_approval'],
    })
    expect(h.page.composerWaits).toBe(1)
    expect(clicks(h.page)).toEqual(['e31'])
    expect(await db.select().from(llmCalls)).toHaveLength(0)
  })

  it('clicks a collapsed composer past the snapshot cut, then fills the opened editor', async () => {
    const h = await harness({ routes: { [THREAD_URL]: redditLongThread } })
    const outcome = await fastPath(h)
    expect(outcome.end).toBe('approval_requested')
    expect(clicks(h.page)).toEqual(['e8'])
    expect(h.page.actions).toContainEqual({ type: 'fill', ref: 'e20', value: COMMENT })
  })

  it('never fills an editor outside the top-level composer', async () => {
    const h = await harness({
      routes: { [THREAD_URL]: () => ({ ...redditComposer(), nonTopLevelRefs: ['e20'] }) },
    })
    const outcome = await fastPath(h)
    expect(outcome).toMatchObject({ end: 'handoff', reason: 'no_form' })
    expect(h.page.actions.some((action) => action.type === 'fill')).toBe(false)
  })

  it('fills both post fields in order and approves them together', async () => {
    const h = await harness({
      action: 'reddit_post',
      spec: {
        version: 1,
        targetUrl: POST_URL,
        fields: [
          { key: 'post_title', value: 'A title', provenance: 'user_verbatim' },
          { key: 'post_body', value: 'A body', provenance: 'user_verbatim' },
        ],
      },
      routes: { [POST_URL]: () => redditPostComposer() },
    })
    expect(await fastPath(h)).toMatchObject({ end: 'approval_requested', actions: 3 })
    expect(h.approvals[0]?.fields.map((field) => [field.key, field.value])).toEqual([
      ['post_title', 'A title'],
      ['post_body', 'A body'],
    ])
  })

  it('drafts an application note once, opens Apply once, and requests approval', async () => {
    const composer = (): FakePageModel => ({
      url: JOB_URL,
      snapshot:
        '- main [ref=e1]:\n  - textbox "Application note" [ref=e20]\n  - button "Send" [ref=e22]\n  - button "Apply" [ref=e8]',
    })
    const job = (): FakePageModel => ({
      url: JOB_URL,
      snapshot: '- main [ref=e1]:\n  - heading "Engineer" [ref=e2]\n  - button "Apply" [ref=e8]',
      onClick: { e8: composer },
    })
    const h = await harness({
      site: 'waas',
      action: 'waas_apply',
      spec: { version: 1, targetUrl: JOB_URL, fields: [], composeNote: true },
      routes: { [JOB_URL]: job },
      note: 'SENTINEL-NOTE',
    })
    const outcome = await fastPath(h)
    expect(outcome).toMatchObject({ end: 'approval_requested' })
    expect(h.composed).toBe(1)
    expect(clicks(h.page)).toEqual(['e8'])
    expect(h.approvals[0]?.fields[0]).toMatchObject({ value: 'SENTINEL-NOTE' })
    expect(JSON.stringify(outcome)).not.toContain('SENTINEL')
    expect(h.page.composerWaits).toBe(0)
  })

  it('stops without acting on an already-applied job', async () => {
    const h = await harness({
      site: 'waas',
      action: 'waas_apply',
      spec: { version: 1, targetUrl: JOB_URL, fields: [], composeNote: true },
      routes: {
        [JOB_URL]: () => ({
          url: JOB_URL,
          snapshot: '- main [ref=e1]:\n  - button "Applied" [ref=e8]',
        }),
      },
    })
    expect(await fastPath(h)).toMatchObject({ end: 'stopped', actions: 0 })
    expect(h.toolbox.alreadyApplied).toBe(true)
    expect(h.composed).toBe(0)
  })
})

describe('fast path comment drafting and handoffs', () => {
  const pending: BrowserTaskSpecV1 = {
    version: 1,
    targetUrl: THREAD_URL,
    fields: [],
    composeComment: { thoughts: '', priorRunIds: [] },
  }

  it('drafts once after reading the thread and fills the drafted text', async () => {
    const h = await harness({
      spec: structuredClone(pending),
      compose: async () => ({
        version: 1,
        targetUrl: THREAD_URL,
        fields: [{ key: 'comment_text', value: 'Drafted.', provenance: 'drafted' }],
      }),
    })
    expect(await fastPath(h)).toMatchObject({ end: 'approval_requested' })
    expect(h.composed).toBe(1)
    expect(h.approvals[0]?.fields[0]).toMatchObject({ value: 'Drafted.', provenance: 'drafted' })
  })

  it('stops for advice when the draft needs a question answered', async () => {
    const h = await harness({ spec: structuredClone(pending), compose: async () => undefined })
    expect(await fastPath(h)).toMatchObject({ end: 'stopped' })
    expect(h.toolbox.adviceRequired).toBe(true)
    expect(clicks(h.page)).toEqual([])
  })

  it('continues after a resolved human handoff and stops on an unresolved one', async () => {
    const resolved = await harness({
      routes: { [THREAD_URL]: challengePage },
      human: async (page) => {
        page.setModel(redditThread())
        return 'resolved'
      },
    })
    expect(await fastPath(resolved)).toMatchObject({ end: 'approval_requested' })
    expect(resolved.handoffs).toHaveLength(1)

    await truncateAllTables()
    const cancelled = await harness({
      routes: { [THREAD_URL]: challengePage },
      human: async () => 'cancelled',
    })
    expect(await fastPath(cancelled)).toMatchObject({ end: 'stopped', actions: 0 })
    expect(cancelled.approvals).toHaveLength(0)
  })

  it('checks cancellation and shutdown before touching the browser', async () => {
    const cancel = new AbortController()
    cancel.abort()
    const h = await harness()
    expect(await fastPath(h, { cancel: cancel.signal })).toMatchObject({ end: 'cancelled' })
    const shutdown = new AbortController()
    shutdown.abort()
    expect(await fastPath(h, { shutdown: shutdown.signal })).toMatchObject({
      end: 'interrupted',
    })
    expect(h.page.actions).toEqual([])
  })

  it('hands off instead of retrying an approval refused on read-back', async () => {
    const h = await harness({
      routes: {
        [THREAD_URL]: () => ({
          ...redditThread(),
          onClick: { e8: () => redditComposer({ readBack: () => 'edited by the page' }) },
        }),
      },
    })
    expect(await fastPath(h)).toMatchObject({
      end: 'handoff',
      reason: 'no_progress',
      trail: [
        'click_opener button',
        'fill_field comment_text',
        'request_submit_approval (refused)',
      ],
    })
    expect(h.approvals).toHaveLength(0)
    const approvalCalls = (await calls(h.runId)).filter(
      (row) => row.toolName === 'browser.request_submit_approval',
    )
    expect(approvalCalls.map((row) => row.status)).toEqual(['failed'])
  })

  it('does nothing more after approval, whatever the user decided', async () => {
    const h = await harness({ approval: 'denied' })
    expect(await fastPath(h)).toMatchObject({ end: 'approval_requested' })
    expect(h.page.actions.at(-1)).toEqual({ type: 'screenshot' })
    expect(clicks(h.page)).toEqual(['e8'])
  })
})

describe('rules policy with model fallback', () => {
  const config = {
    maxSteps: 6,
    maxOutputTokens: 500,
    stepTimeoutMs: 30_000,
    reasoningEffort: 'medium',
  } as AgentConfig

  it('never calls the model when the fast path reaches approval', async () => {
    const h = await harness()
    const { site, action } = siteAction('reddit', 'reddit_comment')
    const outcome = await runFastPathThenAgent({
      model: scriptedModel([]),
      config,
      toolbox: h.toolbox,
      site,
      action,
      spec: h.spec,
      instruction: 'comment',
    })
    expect(outcome).toEqual({ end: 'approval_requested', steps: 0 })
  })

  it('hands an ambiguous form to the model on the same page, which finishes it', async () => {
    const twoEditors = (): FakePageModel => ({
      url: THREAD_URL,
      snapshot: [
        '- main [ref=e1]:',
        '  - textbox "Comment" [ref=e20]',
        '  - textbox "Notes" [ref=e30]',
        '  - button "Comment" [ref=e22]',
      ].join('\n'),
    })
    const h = await harness({ routes: { [THREAD_URL]: twoEditors } })
    const { site, action } = siteAction('reddit', 'reddit_comment')
    const prompts: string[] = []
    const model = createBudgetedModel(
      scriptedModel([
        async (params) => {
          prompts.push(JSON.stringify(params.prompt))
          return toolCallResult('snapshot', {})
        },
        toolCallResult('fill_field', { ref: '2:e20', fieldKey: 'comment_text' }),
        toolCallResult('snapshot', {}),
        toolCallResult('request_submit_approval', {
          submitRef: '3:e22',
          fieldRefs: { comment_text: '3:e20' },
        }),
      ]),
      {
        db,
        runId: h.runId,
        purpose: 'agent_browser_step',
        model: 'gpt-6-luna',
        maxOutputTokens: 500,
        taskMaxUsd: 0.05,
      },
    )
    const outcome = await runFastPathThenAgent({
      model,
      config,
      toolbox: h.toolbox,
      site,
      action,
      spec: h.spec,
      instruction: 'comment',
    })

    expect(outcome).toEqual({ end: 'approval_requested', steps: 4 })
    expect(prompts[0]).toContain('Preparation is already underway on the open page.')
    expect(prompts[0]).toContain('Start with snapshot')
    expect(prompts[0]).not.toContain('SENTINEL')
    // One navigation by the fast path; the model resumed on the open page.
    expect(h.page.actions.filter((action) => action.type === 'goto')).toHaveLength(1)
    expect(h.approvals[0]?.fields[0]).toMatchObject({ value: COMMENT })
    expect(await db.select().from(llmCalls)).toHaveLength(4)
  })
})
