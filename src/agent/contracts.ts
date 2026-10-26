import { z } from 'zod'
import {
  BROWSER_STATUS_REASON_MAX_CHARS,
  BROWSER_TASK_URL_MAX_CHARS,
} from '../db/schema/browser.js'
import type { browserTaskStatus } from '../db/schema/enums.js'

/** v1 bound for one posted field (see "Posted text limit" in the phase 05 record). */
export const BROWSER_FIELD_VALUE_MAX_CHARS = 3_000
export const BROWSER_FIELD_MAX_COUNT = 8

export type BrowserTaskStatus = (typeof browserTaskStatus.enumValues)[number]

/** Statuses guarded by the one-active-task index; `queued` waits for the slot. */
export const BROWSER_TASK_HOLDING_STATUSES = [
  'running',
  'waiting_for_human',
  'awaiting_approval',
  'executing',
] as const satisfies readonly BrowserTaskStatus[]

/** Statuses with `finished_at` null (the active/finished CHECK). */
export const BROWSER_TASK_OPEN_STATUSES = [
  'queued',
  ...BROWSER_TASK_HOLDING_STATUSES,
] as const satisfies readonly BrowserTaskStatus[]

/** Terminal statuses that require `submitted_at` (the submitted CHECK). */
export const BROWSER_TASK_SUBMITTED_STATUSES = [
  'succeeded',
  'unverified',
  'outcome_unknown',
] as const satisfies readonly BrowserTaskStatus[]

/** `browser_tasks.status_reason` text catalog. New reasons are code changes, not migrations. */
export const BROWSER_TASK_STATUS_REASONS = [
  'interrupted',
  'approval_expired',
  'budget_exhausted',
  'daily_cap',
  'precondition_failed',
  'step_limit',
  'login_required',
  'handoff_timeout',
  'handoff_limit',
  'cancelled_by_user',
  'confirmation_required',
  'advice_required',
  'already_applied',
  'schedule_missed',
] as const
export type BrowserTaskStatusReason = (typeof BROWSER_TASK_STATUS_REASONS)[number]

/** Model-call purposes for the agent; all share the `agent_` prefix counted by D044. */
export const AGENT_LLM_PURPOSES = [
  'agent_intake',
  'agent_browser_step',
  'agent_compose_text',
] as const

const httpsUrl = z
  .string()
  .max(BROWSER_TASK_URL_MAX_CHARS)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:'
    } catch {
      return false
    }
  }, 'must be an https URL')

const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'must be a lowercase field key')
const fieldValue = z.string().min(1).max(BROWSER_FIELD_VALUE_MAX_CHARS)
const siteKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
const actionKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)

/**
 * Where a field value came from (D046). `user_verbatim` must be an exact substring of the
 * user's message; `drafted` is agent-written text, always labelled "(drafted)" for approval.
 */
export const fieldProvenance = z.enum(['user_verbatim', 'drafted'])

const uniqueKeys = <T extends { key: string }>(fields: T[]) =>
  new Set(fields.map((field) => field.key)).size === fields.length

export const commentCompositionRequest = z
  .object({
    thoughts: z.string().max(BROWSER_FIELD_VALUE_MAX_CHARS).default(''),
    question: z.string().min(1).max(300).optional(),
    answer: z.string().min(1).max(BROWSER_FIELD_VALUE_MAX_CHARS).optional(),
    // Bounded run references preserve the per-task cap across one advice pause and retries.
    priorRunIds: z.array(z.uuid()).max(8).default([]),
  })
  .strict()

export function isTaskPreparationGated(reason: string | null): boolean {
  return reason === 'confirmation_required' || reason === 'advice_required'
}

/** Pending composers have no fields; prepared tasks always have pinned fields. */
export const browserTaskSpecV1 = z
  .object({
    version: z.literal(1),
    targetUrl: httpsUrl,
    fields: z
      .array(z.object({ key: fieldKey, value: fieldValue, provenance: fieldProvenance }).strict())
      .min(0)
      .max(BROWSER_FIELD_MAX_COUNT)
      .refine(uniqueKeys, 'field keys must be unique'),
    /** Application notes are composed from the profile after observing the job. */
    composeNote: z.literal(true).optional(),
    composeComment: commentCompositionRequest.optional(),
  })
  .strict()
  .refine(
    (spec) =>
      !(spec.composeNote && spec.composeComment) &&
      (spec.composeNote || spec.composeComment ? spec.fields.length === 0 : spec.fields.length > 0),
    'a pending composer has no fields; a prepared task has pinned fields',
  )
export type BrowserTaskSpecV1 = z.infer<typeof browserTaskSpecV1>

const elementTarget = z
  .object({ role: z.string().min(1).max(40), name: z.string().max(200) })
  .strict()

/**
 * `approvals.payload` for `browser.submit` (D042). Immutable after creation and the only source
 * of execution arguments; the executor re-checks the page against it before one click.
 */
export const browserSubmitApprovalPayloadV1 = z
  .object({
    version: z.literal(1),
    taskId: z.uuid(),
    site: siteKey,
    action: actionKey,
    targetUrl: httpsUrl,
    pageUrl: httpsUrl,
    fields: z
      .array(
        elementTarget
          .extend({
            key: fieldKey,
            label: z.string().min(1).max(80),
            value: fieldValue,
            provenance: fieldProvenance,
          })
          .strict(),
      )
      .min(1)
      .max(BROWSER_FIELD_MAX_COUNT)
      .refine(uniqueKeys, 'field keys must be unique'),
    submit: elementTarget,
    screenshot: z
      .object({ artifactId: z.uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict(),
    preparedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export type BrowserSubmitApprovalPayloadV1 = z.infer<typeof browserSubmitApprovalPayloadV1>

/** `browser_tasks.result`: bounded evidence only, never page bodies. */
export const browserTaskResultV1 = z
  .object({
    version: z.literal(1),
    evidenceUrl: httpsUrl.optional(),
    screenshotArtifactId: z.uuid().optional(),
    summary: z.string().max(500).optional(),
  })
  .strict()
export type BrowserTaskResultV1 = z.infer<typeof browserTaskResultV1>

export function isStatusReason(value: string): value is BrowserTaskStatusReason {
  return (
    value.length <= BROWSER_STATUS_REASON_MAX_CHARS &&
    (BROWSER_TASK_STATUS_REASONS as readonly string[]).includes(value)
  )
}
