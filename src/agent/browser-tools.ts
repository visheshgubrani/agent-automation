import { tool } from 'ai'
import { z } from 'zod'
import { type RiskTier, withToolCall } from '../audit/calls.js'
import { applicationStatus } from '../browser/applications.js'
import { recordScreenshot } from '../browser/artifacts.js'
import { type Detection, detectHandoff, type HandoffReason } from '../browser/detectors.js'
import type { BrowserPage, ScrollDirection } from '../browser/driver.js'
import {
  assertAllowedOrigin,
  assertClickAllowed,
  assertKeyAllowed,
  assertSearchInput,
  assertWaitMs,
  GuardError,
  isActionTargetPage,
  isAllowedOrigin,
  isTaskControl,
  matchesElement,
  resolveFillValue,
  SEARCH_QUERY_MAX_CHARS,
} from '../browser/guards.js'
import type { RedditPostContent } from '../browser/reddit.js'
import type { Site, SiteAction } from '../browser/sites.js'
import {
  type AgentSnapshot,
  boundSnapshot,
  SnapshotTracker,
  StaleRefError,
} from '../browser/snapshot.js'
import type { Db } from '../db/index.js'
import { BROWSER_HANDOFF_DETAIL_MAX_CHARS } from '../db/schema/browser.js'
import { errorMessage } from '../errors.js'
import type { Logger } from '../logger.js'
import {
  type BrowserSubmitApprovalPayloadV1,
  type BrowserTaskSpecV1,
  browserSubmitApprovalPayloadV1,
} from './contracts.js'

export const REPORT_SUMMARY_MAX_CHARS = 500
const URL_MAX_CHARS = 2_048

/** Outcome of a handoff, decided by the handoff layer (increment 4). */
export type HumanOutcome = 'resolved' | 'cancelled' | 'timed_out' | 'interrupted' | 'limit_reached'

/** Outcome of an approval request, decided by the approval layer (increment 3). */
export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'cancelled' | 'interrupted'

/**
 * Side effects the tool layer delegates. They own the DB rows, Telegram cards, and waits;
 * the tools own the deterministic checks.
 */
export interface BrowserToolHooks {
  composeNote?(jobExcerpt: string): Promise<BrowserTaskSpecV1>
  composeComment?(post: RedditPostContent): Promise<BrowserTaskSpecV1 | undefined>
  requestHuman(input: {
    reason: HandoffReason
    detail: string
    pageUrl: string
    screenshotArtifactId: string
  }): Promise<HumanOutcome>
  requestSubmitApproval(payload: BrowserSubmitApprovalPayloadV1): Promise<ApprovalOutcome>
}

export interface BrowserToolboxOptions {
  db: Db
  log?: Logger
  runId: string
  taskId: string
  site: Site
  action: SiteAction
  spec: BrowserTaskSpecV1
  page: BrowserPage
  artifactDir: string
  hooks: BrowserToolHooks
  snapshotMaxChars?: number
  now?: () => Date
}

export interface SnapshotToolResult {
  /** Wrapped, bounded, untrusted snapshot text for the model. */
  snapshot: string
  /** Set when a detector stopped the page and the user was asked to step in. */
  handoff?: { reason: HandoffReason; outcome: HumanOutcome }
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * The guarded browser tools (phase 05, D042). Every call is a `tool_calls` row under the task
 * run with its tier and bounded, id-like args: field values and page text are never stored.
 * Guard refusals fail the tool call and reach the model as an error it can recover from.
 */
export class BrowserToolbox {
  readonly tracker: SnapshotTracker
  private readonly opts: BrowserToolboxOptions
  private submitRequested = false
  private readonly filledKeys = new Set<string>()
  private pendingCall: Promise<void> = Promise.resolve()
  private humanOutcome?: HumanOutcome
  private noteAttempted = false
  private commentAttempted = false
  adviceRequired = false
  commentError?: unknown
  private applicationOpened = false
  alreadyApplied = false
  noteError?: unknown

  constructor(options: BrowserToolboxOptions) {
    this.opts = options
    this.tracker = new SnapshotTracker(options.snapshotMaxChars, (element) =>
      isTaskControl(options.action, element),
    )
  }

  /** Field keys filled successfully so far; the agent loop gates approval on all of them. */
  filledFieldKeys(): ReadonlySet<string> {
    return this.filledKeys
  }

  shouldStop(): boolean {
    return (
      this.submitRequested ||
      this.alreadyApplied ||
      this.adviceRequired ||
      this.commentError !== undefined ||
      this.noteError !== undefined ||
      (this.humanOutcome !== undefined && this.humanOutcome !== 'resolved')
    )
  }

  private call<T>(
    toolName: string,
    riskTier: RiskTier,
    args: Record<string, unknown>,
    handler: () => Promise<T>,
    toResult: (value: T) => unknown = () => ({ ok: true }),
  ): Promise<T> {
    const pending = this.pendingCall.then(() =>
      withToolCall(
        {
          db: this.opts.db,
          ...(this.opts.log !== undefined ? { log: this.opts.log } : {}),
          runId: this.opts.runId,
          toolName: `browser.${toolName}`,
          riskTier,
          args,
          auditResult: toResult,
        },
        async () => {
          if (this.submitRequested)
            throw new GuardError(
              'approval_already_requested',
              'this task already requested approval',
            )
          if (this.shouldStop()) throw new GuardError('task_stopped', 'this task has stopped')
          return handler()
        },
      ),
    )
    this.pendingCall = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  private async takeSnapshot(): Promise<AgentSnapshot> {
    assertAllowedOrigin(this.opts.site, this.opts.page.url())
    const raw = await this.opts.page.ariaSnapshot()
    return this.tracker.record(raw, this.opts.page.url())
  }

  private async screenshotArtifact(): Promise<{ id: string; sha256: string }> {
    const bytes = await this.opts.page.screenshot()
    const row = await recordScreenshot(this.opts.db, {
      artifactDir: this.opts.artifactDir,
      bytes,
      taskId: this.opts.taskId,
    })
    return { id: row.id, sha256: row.sha256 }
  }

  private async detect(snapshot: { text: string }): Promise<Detection | undefined> {
    const page = this.opts.page
    const frames = await page.frameObservations()
    // Detectors read only headings/short text of the bounded snapshot plus frame URLs.
    return detectHandoff(this.opts.site, {
      url: page.url(),
      title: await page.title(),
      frameUrls: page.frameUrls(),
      frames,
      snapshot: snapshot.text,
    })
  }

  private async checkApprovalPage(snapshot: { text: string }): Promise<void> {
    if (await this.detect(snapshot)) {
      await this.observe()
      throw new GuardError(
        'handoff_needed',
        'the page needed human help; take a new snapshot and fill the fields again',
      )
    }
  }

  /**
   * Snapshot the page and run the detectors; on a hit, hand off to the user and, once they
   * tap Done, look again. Repeated hits keep handing off until the handoff layer stops.
   */
  private async observe(): Promise<SnapshotToolResult> {
    let snapshot = await this.takeSnapshot()
    let detection = await this.detect(snapshot)
    let last: SnapshotToolResult['handoff']
    while (detection) {
      const screenshot = await this.screenshotArtifact()
      const outcome = await this.handoff({
        reason: detection.reason,
        detail: detection.detail,
        pageUrl: bounded(this.opts.page.url(), URL_MAX_CHARS),
        screenshotArtifactId: screenshot.id,
      })
      last = { reason: detection.reason, outcome }
      if (outcome !== 'resolved') return { snapshot: snapshot.text, handoff: last }
      snapshot = await this.takeSnapshot()
      detection = await this.detect(snapshot)
    }
    if (
      this.opts.action.application &&
      isActionTargetPage(this.opts.action, this.opts.spec.targetUrl, this.opts.page.url())
    ) {
      this.alreadyApplied = applicationStatus(this.opts.action, snapshot.text, 'alreadyApplied')
      if (!this.alreadyApplied && this.opts.spec.composeNote && !this.noteAttempted) {
        this.noteAttempted = true
        try {
          if (!this.opts.hooks.composeNote)
            throw new Error('Application note drafting is unavailable.')
          const prepared = await this.opts.hooks.composeNote(snapshot.text)
          if (
            prepared.targetUrl !== this.opts.spec.targetUrl ||
            prepared.composeNote ||
            prepared.fields.length !== 1 ||
            prepared.fields[0]?.key !== 'application_note' ||
            prepared.fields[0]?.provenance !== 'drafted'
          )
            throw new Error('Invalid application note.')
          this.opts.spec.fields = prepared.fields
          delete this.opts.spec.composeNote
        } catch (error) {
          this.noteError = error
          throw new GuardError(
            'note_failed',
            'Application note preparation failed; stop this task.',
          )
        }
      }
    }
    if (
      this.opts.spec.composeComment &&
      !this.commentAttempted &&
      isActionTargetPage(this.opts.action, this.opts.spec.targetUrl, this.opts.page.url())
    ) {
      this.commentAttempted = true
      try {
        if (!this.opts.hooks.composeComment) throw new Error('Comment drafting is unavailable.')
        const prepared = await this.opts.hooks.composeComment(
          await this.opts.page.readRedditPost(this.opts.spec.targetUrl),
        )
        if (!prepared) this.adviceRequired = true
        else {
          if (
            prepared.targetUrl !== this.opts.spec.targetUrl ||
            prepared.composeComment ||
            prepared.composeNote ||
            prepared.fields.length !== 1 ||
            prepared.fields[0]?.key !== 'comment_text' ||
            prepared.fields[0]?.provenance !== 'drafted'
          )
            throw new Error('Invalid comment draft.')
          this.opts.spec.fields = prepared.fields
          delete this.opts.spec.composeComment
        }
      } catch (error) {
        this.commentError = error
        throw new GuardError('comment_failed', 'Comment preparation failed; stop this task.')
      }
    }
    return { snapshot: snapshot.text, ...(last !== undefined ? { handoff: last } : {}) }
  }

  private async handoff(
    input: Parameters<BrowserToolHooks['requestHuman']>[0],
  ): Promise<HumanOutcome> {
    const outcome = await this.opts.hooks.requestHuman(input)
    this.humanOutcome = outcome
    this.filledKeys.clear()
    this.tracker.invalidate()
    return outcome
  }

  /** After anything that may navigate: refs are stale, and leaving the site is undone. */
  private async afterPageChange(): Promise<SnapshotToolResult> {
    this.tracker.invalidate()
    if (!isAllowedOrigin(this.opts.site, this.opts.page.url())) {
      await this.opts.page.goBack().catch(() => undefined)
      throw new GuardError('origin_left', `that left ${this.opts.site.label}; went back`)
    }
    return this.observe()
  }

  private snapshotAudit = (result: SnapshotToolResult) => ({
    generation: this.tracker.current()?.generation ?? null,
    truncated: this.tracker.current()?.truncated ?? null,
    ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
  })

  navigate(url: string): Promise<SnapshotToolResult> {
    return this.call(
      'navigate',
      'read',
      { url: bounded(url, URL_MAX_CHARS) },
      async () => {
        assertAllowedOrigin(this.opts.site, url)
        await this.opts.page.goto(url)
        return this.afterPageChange()
      },
      this.snapshotAudit,
    )
  }

  snapshot(): Promise<SnapshotToolResult> {
    return this.call('snapshot', 'read', {}, () => this.observe(), this.snapshotAudit)
  }

  /** Stored as an artifact for Telegram and evidence; the image is never sent to the model. */
  screenshot(): Promise<{ artifactId: string }> {
    return this.call(
      'screenshot',
      'read',
      {},
      async () => ({ artifactId: (await this.screenshotArtifact()).id }),
      (value) => value,
    )
  }

  click(ref: string): Promise<SnapshotToolResult> {
    return this.call(
      'click',
      'draft',
      { ref },
      async () => {
        const element = this.tracker.resolve(ref)
        assertClickAllowed(this.opts.site, this.opts.action, element, this.opts.page.url())
        if (
          this.opts.action.application &&
          this.opts.action.preCommitOpeners.some((matcher) => matchesElement(matcher, element))
        ) {
          const fields = [...(this.tracker.current()?.elements.values() ?? [])]
          if (
            this.applicationOpened ||
            !isActionTargetPage(this.opts.action, this.opts.spec.targetUrl, this.opts.page.url()) ||
            fields.some((candidate) =>
              this.opts.action.fields.some(
                (field) => field.roles.includes(candidate.role) && field.name?.test(candidate.name),
              ),
            )
          )
            throw new GuardError(
              'not_a_precommit_opener',
              'Apply may only open the requested job form once, before a note editor is visible.',
            )
          this.applicationOpened = true
        }
        await this.opts.page.click(element.ref)
        return this.afterPageChange()
      },
      this.snapshotAudit,
    )
  }

  /** Types the spec value for `fieldKey` exactly; the model never supplies the text. */
  fillField(ref: string, fieldKey: string): Promise<{ filled: string }> {
    return this.call(
      'fill_field',
      'draft',
      { ref, fieldKey },
      async () => {
        const element = this.tracker.resolve(ref)
        const value = resolveFillValue(this.opts.action, this.opts.spec, fieldKey, element)
        if (
          this.opts.action.key === 'reddit_comment' &&
          !isActionTargetPage(this.opts.action, this.opts.spec.targetUrl, this.opts.page.url())
        )
          throw new GuardError('wrong_target', 'Return to the requested thread before filling.')
        if (
          this.opts.action.key === 'reddit_comment' &&
          !(await this.opts.page.isRedditCommentComposer(element.ref, this.opts.spec.targetUrl))
        )
          throw new GuardError(
            'wrong_composer',
            'Use the requested post’s top-level comment composer.',
          )
        await this.opts.page.fill(element.ref, value)
        this.filledKeys.add(fieldKey)
        this.tracker.invalidate()
        return { filled: fieldKey }
      },
      (value) => value,
    )
  }

  typeSearch(ref: string, query: string): Promise<SnapshotToolResult> {
    return this.call(
      'type_search',
      'draft',
      { ref, query: bounded(query, SEARCH_QUERY_MAX_CHARS) },
      async () => {
        const element = this.tracker.resolve(ref)
        assertSearchInput(element, query)
        await this.opts.page.fill(element.ref, query)
        this.tracker.invalidate()
        return this.observe()
      },
      this.snapshotAudit,
    )
  }

  press(key: string, ref?: string): Promise<SnapshotToolResult> {
    return this.call(
      'press',
      'draft',
      { key: bounded(key, 32), ...(ref !== undefined ? { ref } : {}) },
      async () => {
        const element = ref !== undefined ? this.tracker.resolve(ref) : undefined
        assertKeyAllowed(key, element)
        await this.opts.page.press(key, element?.ref)
        return this.afterPageChange()
      },
      this.snapshotAudit,
    )
  }

  scroll(direction: ScrollDirection): Promise<SnapshotToolResult> {
    return this.call(
      'scroll',
      'read',
      { direction },
      async () => {
        await this.opts.page.scroll(direction)
        this.tracker.invalidate()
        return this.observe()
      },
      this.snapshotAudit,
    )
  }

  wait(ms: number): Promise<SnapshotToolResult> {
    return this.call(
      'wait',
      'read',
      { ms },
      async () => {
        assertWaitMs(ms)
        await this.opts.page.wait(ms)
        this.tracker.invalidate()
        return this.observe()
      },
      this.snapshotAudit,
    )
  }

  /** The agent asks the user to step in (captcha, login, anything it should not handle). */
  requestHuman(reason: HandoffReason, detail: string): Promise<HumanOutcome> {
    const safeDetail = bounded(detail, Math.min(300, BROWSER_HANDOFF_DETAIL_MAX_CHARS))
    return this.call(
      'request_human',
      'notify',
      { reason },
      async () => {
        const screenshot = await this.screenshotArtifact()
        const outcome = await this.handoff({
          reason,
          detail: safeDetail,
          pageUrl: bounded(this.opts.page.url(), URL_MAX_CHARS),
          screenshotArtifactId: screenshot.id,
        })
        if (outcome !== 'resolved') return outcome
        const observed = await this.observe()
        return observed.handoff?.outcome ?? 'resolved'
      },
      (outcome) => ({ outcome }),
    )
  }

  /**
   * Read back every field and require exact equality with the spec, check the submit control
   * against the action's commit pattern, screenshot, and hand the immutable payload to the
   * approval layer. Nothing is clicked here; only the executor clicks, after approval.
   */
  requestSubmitApproval(
    submitRef: string,
    fieldRefs: Record<string, string>,
  ): Promise<ApprovalOutcome> {
    return this.call(
      'request_submit_approval',
      'draft',
      { submitRef, fieldRefs },
      async () => {
        if (this.submitRequested) {
          throw new GuardError('approval_already_requested', 'this task already requested approval')
        }
        const { site, action, spec, page } = this.opts
        const pageUrl = page.url()
        assertAllowedOrigin(site, pageUrl)
        if (!isActionTargetPage(action, spec.targetUrl, pageUrl))
          throw new GuardError(
            'wrong_target',
            'return to the requested subreddit or job before preparing approval',
          )
        if (spec.composeNote || spec.composeComment || spec.fields.length !== action.fields.length)
          throw new GuardError(
            'missing_fields',
            'Every required field must be pinned before approval.',
          )
        if (new Set(Object.values(fieldRefs)).size !== Object.values(fieldRefs).length)
          throw new GuardError('duplicate_field_ref', 'each field must have a different ref')
        // Detect a replaced page before trying to read editor controls that may have vanished.
        // This bounded observation does not replace the refs supplied for the prepared form.
        const approvalSnapshot = await page.ariaSnapshot()
        await this.checkApprovalPage(boundSnapshot(approvalSnapshot, this.opts.snapshotMaxChars))
        if (applicationStatus(action, approvalSnapshot, 'alreadyApplied')) {
          this.alreadyApplied = true
          throw new GuardError(
            'already_applied',
            'This job is already applied; stop without submitting.',
          )
        }

        const submit = this.tracker.resolve(submitRef)
        if (!matchesElement(action.commit, submit)) {
          throw new GuardError(
            'not_the_commit_control',
            `the submit ref must be the ${action.label} control`,
          )
        }
        if (submit.flags.includes('disabled') || !(await page.isEnabled(submit.ref))) {
          throw new GuardError('element_disabled', 'the submit control is disabled')
        }

        if (
          action.key === 'reddit_comment' &&
          !(await page.isRedditCommentComposer(submit.ref, spec.targetUrl))
        )
          throw new GuardError(
            'wrong_composer',
            'Use the requested post’s top-level comment composer.',
          )
        const fields: BrowserSubmitApprovalPayloadV1['fields'] = []
        const keys = new Set(Object.keys(fieldRefs))
        for (const field of action.fields) {
          const specField = spec.fields.find((candidate) => candidate.key === field.key)
          if (!specField) {
            if (keys.has(field.key))
              throw new GuardError('field_not_in_spec', `this task has no value for "${field.key}"`)
            continue
          }
          const ref = fieldRefs[field.key]
          if (ref === undefined)
            throw new GuardError('missing_field_ref', `provide the ref of the "${field.key}" field`)
          const element = this.tracker.resolve(ref)
          resolveFillValue(action, spec, field.key, element)
          if (
            action.key === 'reddit_comment' &&
            !(await page.isRedditCommentComposer(element.ref, spec.targetUrl))
          )
            throw new GuardError(
              'wrong_composer',
              'Use the requested post’s top-level comment composer.',
            )
          const actual = await page.readValue(element.ref)
          if (actual !== specField.value) {
            throw new GuardError(
              'readback_mismatch',
              `"${field.key}" does not contain exactly the task text; fill it again`,
            )
          }
          fields.push({
            key: field.key,
            label: field.label,
            role: element.role,
            name: bounded(element.name, 200),
            value: specField.value,
            provenance: specField.provenance,
          })
          keys.delete(field.key)
        }
        if (keys.size > 0)
          throw new GuardError('unknown_field', `unknown field refs: ${[...keys].join(', ')}`)

        const snapshot = await this.takeSnapshot()
        await this.checkApprovalPage(snapshot)

        const screenshot = await this.screenshotArtifact()
        const payload = browserSubmitApprovalPayloadV1.parse({
          version: 1,
          taskId: this.opts.taskId,
          site: site.key,
          action: action.key,
          targetUrl: spec.targetUrl,
          pageUrl,
          fields,
          submit: { role: submit.role, name: bounded(submit.name, 200) },
          screenshot: { artifactId: screenshot.id, sha256: screenshot.sha256 },
          preparedAt: (this.opts.now?.() ?? new Date()).toISOString(),
        })
        this.submitRequested = true
        return this.opts.hooks.requestSubmitApproval(payload)
      },
      (outcome) => ({ outcome }),
    )
  }

  /** Ends a read-only task; needs no approval. */
  reportResult(summary: string): Promise<{ summary: string }> {
    const safe = bounded(summary, REPORT_SUMMARY_MAX_CHARS)
    return this.call(
      'report_result',
      'read',
      { summary: safe },
      async () => ({ summary: safe }),
      (value) => value,
    )
  }
}

/** Model-facing text for a refusal or failure; never includes page content. */
export function toolErrorText(error: unknown): string {
  if (error instanceof GuardError || error instanceof StaleRefError)
    return `refused: ${error.message}`
  return `failed: ${errorMessage(error, 300)}`
}

async function safely<T>(run: () => Promise<T>, format: (value: T) => string): Promise<string> {
  try {
    return format(await run())
  } catch (error) {
    return toolErrorText(error)
  }
}

function snapshotText(result: SnapshotToolResult): string {
  if (result.handoff && result.handoff.outcome !== 'resolved') {
    return `handoff ${result.handoff.reason}: ${result.handoff.outcome}. Stop and call report_result.`
  }
  return result.snapshot
}

const ref = z.string().max(24).describe('A ref from the latest snapshot, like "3:e12"')

/**
 * AI SDK tool definitions over a toolbox. Inputs are strictly typed and bounded; every
 * result is text. The model never receives screenshots or raw page objects.
 */
export function createBrowserAgentTools(toolbox: BrowserToolbox) {
  return {
    navigate: tool({
      description: 'Open an https URL on this site. Returns a fresh snapshot.',
      inputSchema: z.object({ url: z.string().max(URL_MAX_CHARS) }),
      execute: ({ url }) => safely(() => toolbox.navigate(url), snapshotText),
    }),
    snapshot: tool({
      description: 'Read the current page as an untrusted accessibility snapshot with refs.',
      inputSchema: z.object({}),
      execute: () => safely(() => toolbox.snapshot(), snapshotText),
    }),
    screenshot: tool({
      description: 'Store a screenshot for the user. You do not see the image.',
      inputSchema: z.object({}),
      execute: () =>
        safely(
          () => toolbox.screenshot(),
          () => 'screenshot stored',
        ),
    }),
    click: tool({
      description: 'Click an element. Submit/post/commit controls are refused before approval.',
      inputSchema: z.object({ ref }),
      execute: (input) => safely(() => toolbox.click(input.ref), snapshotText),
    }),
    fill_field: tool({
      description:
        "Type the task's exact value for fieldKey into a field. You cannot choose the text.",
      inputSchema: z.object({ ref, fieldKey: z.string().max(48) }),
      execute: (input) =>
        safely(
          () => toolbox.fillField(input.ref, input.fieldKey),
          (r) => `filled ${r.filled}`,
        ),
    }),
    type_search: tool({
      description: 'Type a short one-line query into a search box or combo box.',
      inputSchema: z.object({ ref, query: z.string().max(SEARCH_QUERY_MAX_CHARS) }),
      execute: (input) => safely(() => toolbox.typeSearch(input.ref, input.query), snapshotText),
    }),
    press: tool({
      description:
        'Press a navigation key (Tab, Escape, arrows, PageUp/Down, Home, End), or Enter in a search box.',
      inputSchema: z.object({ key: z.string().max(32), ref: ref.optional() }),
      execute: (input) => safely(() => toolbox.press(input.key, input.ref), snapshotText),
    }),
    scroll: tool({
      description:
        'Scroll the viewport (to load more content). Snapshots always start at the top of the page; scrolling does not change which part you see.',
      inputSchema: z.object({ direction: z.enum(['up', 'down']) }),
      execute: (input) => safely(() => toolbox.scroll(input.direction), snapshotText),
    }),
    wait: tool({
      description: 'Wait 100–5000 ms for the page to settle.',
      inputSchema: z.object({ ms: z.number().int() }),
      execute: (input) => safely(() => toolbox.wait(input.ms), snapshotText),
    }),
    request_human: tool({
      description:
        'Ask the user to step in (login, captcha, 2FA, verification, or anything you should not do).',
      inputSchema: z.object({
        reason: z.enum(['captcha', 'login', 'two_factor', 'verification', 'other']),
        detail: z.string().max(300),
      }),
      execute: (input) =>
        safely(
          () => toolbox.requestHuman(input.reason, input.detail),
          (o) =>
            o === 'resolved'
              ? `handoff resolved\n${toolbox.tracker.current()?.text ?? 'Take a fresh snapshot.'}`
              : `handoff ${o}`,
        ),
    }),
    request_submit_approval: tool({
      description:
        'When every field is filled, ask the user to approve the exact submission. Give the submit control ref and each field ref.',
      inputSchema: z.object({ submitRef: ref, fieldRefs: z.record(z.string().max(48), ref) }),
      execute: (input) =>
        safely(
          () => toolbox.requestSubmitApproval(input.submitRef, input.fieldRefs),
          (o) => `approval ${o}`,
        ),
    }),
    report_result: tool({
      description: 'Finish without submitting, with a short summary.',
      inputSchema: z.object({ summary: z.string().max(REPORT_SUMMARY_MAX_CHARS) }),
      execute: (input) =>
        safely(
          () => toolbox.reportResult(input.summary),
          () => 'reported',
        ),
    }),
  }
}
