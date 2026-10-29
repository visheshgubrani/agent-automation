/**
 * Browser preparation before approval. `rules` (the default, D058) runs the model-free fast
 * path first and hands off once to the Responses loop on anything it cannot choose (D056);
 * `llm` runs the Responses loop alone.
 */
import { GuardError } from '../browser/guards.js'
import type { SiteAction } from '../browser/sites.js'
import { StaleRefError } from '../browser/snapshot.js'
import { errorMessage } from '../errors.js'
import type { Logger } from '../logger.js'
import {
  type BrowserAgentOutcome,
  type RunBrowserAgentOptions,
  runBrowserAgent,
} from './browser-agent.js'
import type { BrowserToolbox, SnapshotToolResult } from './browser-tools.js'
import type { BrowserTaskSpecV1 } from './contracts.js'
import {
  elementSignature,
  type FastHandoffReason,
  type FastPathState,
  nextFastAction,
  progressSignature,
  semanticKey,
  siteCheckRefs,
} from './fast-path-rules.js'

/** Browser actions the rules path may take before it hands off (D056, preserved). */
export const FAST_PATH_MAX_ACTIONS = 10
/** Trail entries passed to the model; each is a fixed op plus a registry key or role. */
export const FAST_PATH_TRAIL_MAX = 10

export interface FastPathOptions {
  toolbox: BrowserToolbox
  action: SiteAction
  spec: BrowserTaskSpecV1
  log?: Logger
  shutdownSignal?: AbortSignal
  taskCancelSignal?: AbortSignal
}

export type FastPathEnd = 'approval_requested' | 'handoff' | 'stopped' | 'cancelled' | 'interrupted'

export interface FastPathOutcome {
  end: FastPathEnd
  actions: number
  reason?: FastHandoffReason
  /** Value-free steps taken, e.g. `fill_field comment_text` or `click_opener button`. */
  trail: string[]
}

/** Run the rules until approval is requested, the toolbox stops, or they hand off. */
export async function runFastPath(options: FastPathOptions): Promise<FastPathOutcome> {
  const { toolbox, action, spec } = options
  const trail: string[] = []
  const opened = new Set<string>()
  const done = new Set<string>()
  let actions = 0
  let refusals = 0

  const ended = (): FastPathEnd | undefined => {
    if (options.shutdownSignal?.aborted) return 'interrupted'
    if (options.taskCancelSignal?.aborted) return 'cancelled'
    if (toolbox.shouldStop()) return 'stopped'
    return undefined
  }
  const finish = (end: FastPathEnd, reason?: FastHandoffReason): FastPathOutcome => ({
    end,
    actions,
    ...(reason !== undefined ? { reason } : {}),
    trail,
  })
  const attempt = async <T>(run: () => Promise<T>): Promise<Attempt<T>> => {
    try {
      return { ok: true, value: await run() }
    } catch (error) {
      const refused = error instanceof GuardError || error instanceof StaleRefError
      if (!refused) {
        options.log?.warn({ err: errorMessage(error, 300) }, 'fast path action failed')
      }
      return { ok: false, refused }
    }
  }
  const note = (entry: string, result: Attempt<unknown>) => {
    if (result.ok) trail.push(entry)
    else trail.push(`${entry} (${result.refused ? 'refused' : 'failed'})`)
  }
  const afterObservation = (result: SnapshotToolResult) => {
    if (result.handoff?.outcome === 'resolved') {
      opened.clear()
      done.clear()
    }
  }
  const afterFailure = (failure: { refused: boolean }): FastPathOutcome | undefined => {
    const end = ended()
    if (end) return finish(end)
    if (!failure.refused) return finish('handoff', 'action_failed')
    refusals += 1
    return refusals >= 2 ? finish('handoff', 'refused') : undefined
  }

  let end = ended()
  if (end) return finish(end)
  const navigated = await attempt(() => toolbox.navigate(spec.targetUrl))
  if (navigated.ok) afterObservation(navigated.value)
  else {
    const stop = afterFailure(navigated)
    if (stop) return stop
  }

  for (let pass = 0; pass < FAST_PATH_MAX_ACTIONS * 4; pass += 1) {
    end = ended()
    if (end) return finish(end)
    if (actions >= FAST_PATH_MAX_ACTIONS) return finish('handoff', 'action_cap')

    const snapshot = toolbox.tracker.current()
    if (!snapshot) {
      const observed = await attempt(() => toolbox.snapshot())
      if (observed.ok) afterObservation(observed.value)
      else {
        const stop = afterFailure(observed)
        if (stop) return stop
      }
      continue
    }
    if (spec.composeNote || spec.composeComment) return finish('handoff', 'composition_pending')

    const excluded = new Set<string>()
    let checked = true
    for (const ref of siteCheckRefs(action, snapshot.elements)) {
      const check = await attempt(() =>
        toolbox.isTopLevelCommentComposer(`${snapshot.generation}:${ref}`),
      )
      if (!check.ok) {
        const stop = afterFailure(check)
        if (stop) return stop
        checked = false
        break
      }
      if (!check.value) excluded.add(ref)
    }
    if (!checked || toolbox.tracker.current() !== snapshot) continue

    const state: FastPathState = {
      action,
      generation: snapshot.generation,
      elements: snapshot.elements,
      specKeys: new Set(spec.fields.map((field) => field.key)),
      filled: toolbox.filledFieldKeys(),
      opened,
      excluded,
    }
    const decision = nextFastAction(state)
    if (decision.op === 'hand_off') return finish('handoff', decision.reason)
    const key = `${semanticKey(state, decision)}|${progressSignature(state)}`
    if (done.has(key)) return finish('handoff', 'no_progress')
    done.add(key)
    actions += 1

    switch (decision.op) {
      case 'fill_field': {
        const filled = await attempt(() => toolbox.fillField(decision.ref, decision.fieldKey))
        note(`fill_field ${decision.fieldKey}`, filled)
        if (filled.ok) refusals = 0
        else {
          const stop = afterFailure(filled)
          if (stop) return stop
        }
        break
      }
      case 'click_opener': {
        const element = snapshot.elements.get(decision.ref.slice(decision.ref.indexOf(':') + 1))
        if (element) opened.add(elementSignature(element))
        const clicked = await attempt(() => toolbox.click(decision.ref))
        note(`click_opener ${element?.role ?? 'control'}`, clicked)
        if (clicked.ok) {
          refusals = 0
          afterObservation(clicked.value)
        } else {
          const stop = afterFailure(clicked)
          if (stop) return stop
        }
        break
      }
      case 'approve': {
        const approval = await attempt(() =>
          toolbox.requestSubmitApproval(decision.submitRef, decision.fieldRefs),
        )
        note('request_submit_approval', approval)
        if (approval.ok) return finish('approval_requested')
        const stop = afterFailure(approval)
        if (stop) return stop
        break
      }
    }
  }
  return finish('handoff', 'action_cap')
}

/**
 * The `rules` policy: the fast path first, then, only on a handoff, the model loop on the same
 * page, toolbox, spec and budget. The model starts from a snapshot and never re-enters the
 * fast path; its full step allowance is kept because the fast path makes no model calls.
 */
export async function runFastPathThenAgent(
  options: RunBrowserAgentOptions & { log?: Logger },
): Promise<BrowserAgentOutcome> {
  const { log, ...agentOptions } = options
  const fast = await runFastPath({
    toolbox: options.toolbox,
    action: options.action,
    spec: options.spec,
    ...(log !== undefined ? { log } : {}),
    ...(options.shutdownSignal !== undefined ? { shutdownSignal: options.shutdownSignal } : {}),
    ...(options.taskCancelSignal !== undefined
      ? { taskCancelSignal: options.taskCancelSignal }
      : {}),
  })
  log?.info(
    {
      end: fast.end,
      actions: fast.actions,
      ...(fast.reason !== undefined ? { reason: fast.reason } : {}),
    },
    'browser fast path ended',
  )
  switch (fast.end) {
    case 'approval_requested':
      return { end: 'approval_requested', steps: 0 }
    case 'cancelled':
      return { end: 'cancelled', steps: 0 }
    case 'interrupted':
      return { end: 'interrupted', steps: 0 }
    case 'stopped':
      return { end: 'completed', steps: 0 }
    case 'handoff':
      return runBrowserAgent({
        ...agentOptions,
        resume: {
          filledKeys: [...options.toolbox.filledFieldKeys()],
          trail: fast.trail.slice(-FAST_PATH_TRAIL_MAX),
        },
      })
  }
}

export interface BrowserPreparationOptions extends RunBrowserAgentOptions {
  log?: Logger
}

type Attempt<T> = { ok: true; value: T } | { ok: false; refused: boolean }

/** Prepare a task under the configured step policy. */
export async function runBrowserPreparation(
  options: BrowserPreparationOptions,
): Promise<BrowserAgentOutcome> {
  const { log, ...agentOptions } = options
  if (options.config.stepPolicy === 'rules') {
    return runFastPathThenAgent({ ...agentOptions, ...(log !== undefined ? { log } : {}) })
  }
  return runBrowserAgent(agentOptions)
}
