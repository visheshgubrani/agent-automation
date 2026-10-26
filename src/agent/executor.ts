/**
 * Model-free approval execution (phase 05, D042). Reads arguments only from
 * `approvals.payload`, claims the approval exactly once through `tool_calls(approval_id)`,
 * re-checks the live page, clicks once, and verifies the result deterministically.
 */
import { ToolCallOutcomeUnknownError, withToolCall } from '../audit/calls.js'
import { finishRun, startRun } from '../audit/runs.js'
import { applicationStatus } from '../browser/applications.js'
import { recordScreenshot } from '../browser/artifacts.js'
import { detectHandoff } from '../browser/detectors.js'
import type { BrowserPage } from '../browser/driver.js'
import { isActionTargetPage, isAllowedOrigin, matchesElement } from '../browser/guards.js'
import type { Site, SiteAction } from '../browser/sites.js'
import { parseSnapshotElements, type SnapshotElement } from '../browser/snapshot.js'
import type { Db } from '../db/index.js'
import type { BrowserTaskRow } from '../db/schema/index.js'
import { errorMessage } from '../errors.js'
import type { Logger } from '../logger.js'
import { BROWSER_SUBMIT_TOOL_NAME, type BrowserApprovalRow } from './approvals.js'
import {
  type BrowserSubmitApprovalPayloadV1,
  type BrowserTaskResultV1,
  browserSubmitApprovalPayloadV1,
} from './contracts.js'
import {
  finishBrowserTask,
  isUniqueViolation,
  markTaskSubmitted,
  setTaskExecuting,
} from './tasks.js'

/** Let the site render a posted item before the deterministic verification pass. */
export const POST_SUBMIT_SETTLE_MS = 2_000

/** A deterministic check failed before the click; nothing was submitted. */
class PreconditionError extends Error {
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'PreconditionError'
    this.cause = cause
  }
}

export type ExecutionOutcome =
  | {
      status: 'succeeded' | 'unverified'
      evidenceUrl?: string
      screenshotArtifactId?: string
    }
  | { status: 'failed'; reason: 'precondition_failed'; error: unknown }
  | { status: 'outcome_unknown'; error: unknown }
  /** Another execution already claimed this approval; this attempt left everything alone. */
  | { status: 'conflict' }

export interface ExecuteApprovalOptions {
  db: Db
  log: Logger
  task: BrowserTaskRow
  approval: BrowserApprovalRow
  site: Site
  action: SiteAction
  page: BrowserPage
  artifactDir: string
  now?: () => Date
}

function findUniqueElement(
  elements: readonly SnapshotElement[],
  role: string,
  name: string,
): SnapshotElement | undefined {
  const matches = elements.filter(
    (element) => element.role === role && element.name.trim() === name.trim(),
  )
  return matches.length === 1 ? matches[0] : undefined
}

/** Playwright's actionability wait failed: the click never reached the element. */
function isActionabilityTimeout(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'TimeoutError'
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

interface Verification {
  status: 'succeeded' | 'unverified'
  evidenceUrl: string
}

/**
 * Deterministic post-click verification: a post-submit URL, or the field values appearing in
 * the page outside a still-populated composer. Anything else is reported as `unverified`
 * rather than guessed at.
 */
async function verifySubmission(
  page: BrowserPage,
  action: SiteAction,
  payload: BrowserSubmitApprovalPayloadV1,
): Promise<Verification> {
  const immediateUrl = page.url()
  const isPostTarget = (url: string) => {
    if (action.key === 'reddit_comment') return isActionTargetPage(action, payload.targetUrl, url)
    if (action.key !== 'reddit_post') return true
    const community = /^https:\/\/www\.reddit\.com\/r\/([^/]+)\//.exec(payload.targetUrl)?.[1]
    const actual = /^https:\/\/www\.reddit\.com\/r\/([^/]+)\//.exec(url)?.[1]
    return community !== undefined && community.toLowerCase() === actual?.toLowerCase()
  }
  if (action.postSubmitUrlPattern?.test(immediateUrl) && isPostTarget(immediateUrl)) {
    return { status: 'succeeded', evidenceUrl: immediateUrl }
  }

  await page.wait(POST_SUBMIT_SETTLE_MS)
  const evidenceUrl = page.url()
  const raw = await page.ariaSnapshot()
  const elements = [...parseSnapshotElements(raw).values()]
  if (action.application) {
    const editorVisible = elements.some((element) =>
      action.fields.some(
        (field) => field.roles.includes(element.role) && field.name?.test(element.name),
      ),
    )
    return {
      status:
        isActionTargetPage(action, payload.targetUrl, evidenceUrl) &&
        !editorVisible &&
        applicationStatus(action, raw, 'success')
          ? 'succeeded'
          : 'unverified',
      evidenceUrl,
    }
  }

  let composerCleared = true
  for (const field of payload.fields) {
    const element = findUniqueElement(elements, field.role, field.name)
    if (!element) continue
    const actual = await page.readValue(element.ref)
    if (normalizeText(actual).length > 0) composerCleared = false
  }

  const pageText = normalizeText(raw)
  const valuesVisible = payload.fields.every((field) =>
    pageText.includes(normalizeText(field.value)),
  )
  return {
    status:
      composerCleared && valuesVisible && isPostTarget(evidenceUrl) ? 'succeeded' : 'unverified',
    evidenceUrl,
  }
}

async function safeScreenshot(
  db: Db,
  log: Logger,
  artifactDir: string,
  taskId: string,
  page: BrowserPage,
): Promise<string | undefined> {
  try {
    const row = await recordScreenshot(db, { artifactDir, bytes: await page.screenshot(), taskId })
    return row.id
  } catch (error) {
    log.warn({ err: errorMessage(error), taskId }, 'could not store the execution screenshot')
    return undefined
  }
}

/**
 * Execute an approved submission. Business outcomes are written to the task and to the
 * `approval_execution` child run; a claim conflict is never retried. The caller sends the
 * result card.
 */
export async function executeApproval(options: ExecuteApprovalOptions): Promise<ExecutionOutcome> {
  const { db, log, task, approval, site, action, page } = options
  const now = () => options.now?.() ?? new Date()
  const startedAt = now()

  const childRun = await startRun(db, {
    kind: 'approval_execution',
    trigger: 'approval',
    ...(task.runId !== null ? { parentRunId: task.runId } : {}),
    input: {
      taskId: task.id,
      approvalId: approval.id,
      site: site.key,
      action: action.key,
    },
  })

  let clicked = false

  try {
    const payload = browserSubmitApprovalPayloadV1.parse(approval.payload)
    if (approval.status !== 'approved') {
      throw new PreconditionError('the approval is not approved')
    }
    if (task.status !== 'awaiting_approval') {
      throw new PreconditionError('the task is no longer awaiting approval')
    }

    const outcome = await withToolCall(
      {
        db,
        log,
        runId: childRun.id,
        toolName: BROWSER_SUBMIT_TOOL_NAME,
        riskTier: 'send',
        approvalId: approval.id,
        args: payload as unknown as Record<string, unknown>,
      },
      async () => {
        // The approval payload is the contract: the page must not have moved since approval.
        const pageUrl = page.url()
        if (pageUrl !== payload.pageUrl) {
          throw new PreconditionError('the page URL changed after approval')
        }
        if (!isAllowedOrigin(site, pageUrl)) {
          throw new PreconditionError('the page left the site after approval')
        }
        if (!isActionTargetPage(action, payload.targetUrl, pageUrl))
          throw new PreconditionError('the composer is in a different subreddit or job')

        if (!(await setTaskExecuting(db, { taskId: task.id, now: startedAt }))) {
          throw new PreconditionError('the task is no longer awaiting approval')
        }

        const raw = await page.ariaSnapshot()
        const elements = [...parseSnapshotElements(raw).values()]
        if (applicationStatus(action, raw, 'alreadyApplied'))
          throw new PreconditionError('this job is already applied')

        const frames = await page.frameObservations()
        const detection = detectHandoff(site, {
          url: pageUrl,
          title: await page.title(),
          frameUrls: page.frameUrls(),
          frames,
          snapshot: raw,
        })
        if (detection) {
          throw new PreconditionError(`the page shows a ${detection.detail}`)
        }

        const fieldElements: SnapshotElement[] = []
        for (const field of payload.fields) {
          const element = findUniqueElement(elements, field.role, field.name)
          if (!element) {
            throw new PreconditionError(`the "${field.key}" field is missing or ambiguous`)
          }
          if (
            action.key === 'reddit_comment' &&
            !(await page.isRedditCommentComposer(element.ref, payload.targetUrl))
          )
            throw new PreconditionError(
              'the field is not in the requested top-level comment composer',
            )
          const actual = await page.readValue(element.ref)
          if (actual !== field.value) {
            throw new PreconditionError(`the "${field.key}" field changed after approval`)
          }
          fieldElements.push(element)
        }

        const submit = findUniqueElement(elements, payload.submit.role, payload.submit.name)
        if (!submit) {
          throw new PreconditionError('the submit control is missing or ambiguous')
        }
        if (!matchesElement(action.commit, submit))
          throw new PreconditionError('the submit control does not match the site registry')
        if (fieldElements.some((element) => element.ref === submit.ref)) {
          throw new PreconditionError('the submit control is also a field')
        }
        if (submit.flags.includes('disabled') || !(await page.isEnabled(submit.ref))) {
          throw new PreconditionError('the submit control is disabled')
        }

        if (
          action.key === 'reddit_comment' &&
          !(await page.isRedditCommentComposer(submit.ref, payload.targetUrl))
        )
          throw new PreconditionError(
            'the submit is not in the requested top-level comment composer',
          )
        if (!isActionTargetPage(action, payload.targetUrl, page.url()))
          throw new PreconditionError('the page target changed before clicking')
        try {
          await page.click(submit.ref)
        } catch (error) {
          if (isActionabilityTimeout(error)) {
            throw new PreconditionError('the submit control was not clickable', error)
          }
          // The click may have reached the page: never retry this approval.
          throw new ToolCallOutcomeUnknownError('the submit click outcome is unknown', {
            cause: error,
          })
        }
        clicked = true
        await markTaskSubmitted(db, { taskId: task.id, now: now() })

        const verification = await verifySubmission(page, action, payload)
        const screenshotArtifactId = await safeScreenshot(
          db,
          log,
          options.artifactDir,
          task.id,
          page,
        )
        const result: BrowserTaskResultV1 = {
          version: 1,
          evidenceUrl: verification.evidenceUrl,
          ...(screenshotArtifactId !== undefined ? { screenshotArtifactId } : {}),
        }
        return { verification, screenshotArtifactId, result }
      },
    )

    await finishBrowserTask(db, {
      taskId: task.id,
      from: ['executing'],
      status: outcome.verification.status,
      submittedAt: now(),
      result: outcome.result,
      now: now(),
    })
    await finishRun(db, childRun.id, 'succeeded')
    return {
      status: outcome.verification.status,
      evidenceUrl: outcome.verification.evidenceUrl,
      ...(outcome.screenshotArtifactId !== undefined
        ? { screenshotArtifactId: outcome.screenshotArtifactId }
        : {}),
    }
  } catch (error) {
    if (isUniqueViolation(error, 'tool_calls_approval_uq')) {
      log.warn(
        { taskId: task.id, approvalId: approval.id },
        'approval was already claimed; this execution attempt did nothing',
      )
      await finishRun(db, childRun.id, 'failed', new Error('approval already claimed'))
      return { status: 'conflict' }
    }

    const unknown = error instanceof ToolCallOutcomeUnknownError || clicked
    await finishBrowserTask(db, {
      taskId: task.id,
      from: ['awaiting_approval', 'executing'],
      status: unknown ? 'outcome_unknown' : 'failed',
      ...(unknown ? {} : { statusReason: 'precondition_failed' as const }),
      ...(unknown ? { submittedAt: now() } : {}),
      now: now(),
    })
    await finishRun(db, childRun.id, 'failed', error)
    log.warn(
      { taskId: task.id, approvalId: approval.id, err: errorMessage(error, 300) },
      unknown ? 'approval execution outcome is unknown' : 'approval execution precondition failed',
    )
    return unknown
      ? { status: 'outcome_unknown', error }
      : { status: 'failed', reason: 'precondition_failed', error }
  }
}
