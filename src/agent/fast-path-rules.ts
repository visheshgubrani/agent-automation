/**
 * Model-free rules for the browser fast path (D056). They pick the next preparation step from
 * the site registry and the parsed snapshot elements alone; anything ambiguous hands the task
 * to the model loop. No page prose or field value enters this module's decisions or output.
 */
import { isTaskControl, matchesElement } from '../browser/guards.js'
import type { SiteAction, SiteField } from '../browser/sites.js'
import type { SnapshotElement } from '../browser/snapshot.js'

export type FastHandoffReason =
  | 'missing_field'
  | 'composition_pending'
  | 'ambiguous_field'
  | 'ambiguous_opener'
  | 'no_form'
  | 'ambiguous_approval'
  | 'no_progress'
  | 'refused'
  | 'action_failed'
  | 'action_cap'

export type FastAction =
  | { op: 'fill_field'; ref: string; fieldKey: string }
  | { op: 'click_opener'; ref: string }
  | { op: 'approve'; submitRef: string; fieldRefs: Record<string, string> }
  | { op: 'hand_off'; reason: FastHandoffReason }

export interface FastPathState {
  action: SiteAction
  generation: number
  /** The full parsed snapshot (past any cut), keyed by Playwright ref. */
  elements: ReadonlyMap<string, SnapshotElement>
  /** Field keys pinned in the task spec; values never reach the rules. */
  specKeys: ReadonlySet<string>
  filled: ReadonlySet<string>
  /** Signatures of controls already clicked to open the form since the last human handoff. */
  opened: ReadonlySet<string>
  /** Playwright refs a site check rejected (another Reddit composer). */
  excluded?: ReadonlySet<string>
}

/** Role and accessible name; stable across snapshot generations, unlike refs. */
export function elementSignature(element: Pick<SnapshotElement, 'role' | 'name'>): string {
  return `${element.role}|${element.name.trim()}`
}

function isDisabled(element: SnapshotElement): boolean {
  return element.flags.includes('disabled')
}

function matchesField(field: SiteField, element: SnapshotElement): boolean {
  return (
    field.roles.includes(element.role) &&
    (field.name === undefined || field.name.test(element.name.trim()))
  )
}

function usable(state: FastPathState): SnapshotElement[] {
  return [...state.elements.values()].filter(
    (element) => !isDisabled(element) && !state.excluded?.has(element.ref),
  )
}

/** Elements a field could be filled into, before narrowing. */
export function fieldCandidates(
  state: FastPathState,
  field: SiteField,
): readonly SnapshotElement[] {
  return usable(state).filter((element) => matchesField(field, element))
}

/** Every element matching the commit control, enabled or not; it marks an open form. */
export function commitCandidates(state: FastPathState): readonly SnapshotElement[] {
  return [...state.elements.values()].filter(
    (element) => !state.excluded?.has(element.ref) && matchesElement(state.action.commit, element),
  )
}

/** Refs that need a site check before the rules run: field and commit candidates. */
export function siteCheckRefs(
  action: SiteAction,
  elements: ReadonlyMap<string, SnapshotElement>,
): string[] {
  if (action.key !== 'reddit_comment') return []
  return [...elements.values()]
    .filter(
      (element) =>
        matchesElement(action.commit, element) ||
        action.fields.some((field) => matchesField(field, element)),
    )
    .map((element) => element.ref)
}

/** One element, or the single focused one among several; otherwise ambiguous. */
function single(candidates: readonly SnapshotElement[]): SnapshotElement | undefined {
  if (candidates.length === 1) return candidates[0]
  const active = candidates.filter((element) => element.flags.includes('active'))
  return active.length === 1 ? active[0] : undefined
}

function agentRef(state: FastPathState, element: SnapshotElement): string {
  return `${state.generation}:${element.ref}`
}

/**
 * Filled keys plus the task controls in DOM order (role, name, disabled). Generations and refs
 * are left out, so re-reading an unchanged page is not progress.
 */
export function progressSignature(state: FastPathState): string {
  const controls = [...state.elements.values()]
    .filter((element) => isTaskControl(state.action, element))
    .map((element) => `${elementSignature(element)}|${isDisabled(element) ? 'disabled' : ''}`)
  return JSON.stringify([[...state.filled].sort(), controls])
}

/** What a decision does, without refs: repeating it on an unchanged page is no progress. */
export function semanticKey(state: FastPathState, decision: FastAction): string {
  const element = (ref: string) => {
    const found = state.elements.get(ref.slice(ref.indexOf(':') + 1))
    return found ? elementSignature(found) : ref
  }
  switch (decision.op) {
    case 'fill_field':
      return `fill|${decision.fieldKey}|${element(decision.ref)}`
    case 'click_opener':
      return `click|${element(decision.ref)}`
    case 'approve':
      return 'approve'
    case 'hand_off':
      return `hand_off|${decision.reason}`
  }
}

function approve(state: FastPathState): FastAction {
  const fieldRefs: Record<string, string> = {}
  const used = new Set<string>()
  for (const field of state.action.fields) {
    const element = single(fieldCandidates(state, field))
    if (!element || used.has(element.ref)) return { op: 'hand_off', reason: 'ambiguous_approval' }
    used.add(element.ref)
    fieldRefs[field.key] = agentRef(state, element)
  }
  const submit = single(commitCandidates(state).filter((element) => !isDisabled(element)))
  if (!submit) return { op: 'hand_off', reason: 'ambiguous_approval' }
  return { op: 'approve', submitRef: agentRef(state, submit), fieldRefs }
}

function open(state: FastPathState, formOpen: boolean): FastAction {
  const notOpened = (element: SnapshotElement) => !state.opened.has(elementSignature(element))
  const openers = usable(state).filter(
    (element) =>
      notOpened(element) &&
      state.action.preCommitOpeners.some((matcher) => matchesElement(matcher, element)),
  )
  const [first] = openers
  if (first) {
    // Duplicate openers (a header and a footer Apply) are the same control; take the first.
    if (openers.every((element) => elementSignature(element) === elementSignature(first)))
      return { op: 'click_opener', ref: agentRef(state, first) }
    return { op: 'hand_off', reason: 'ambiguous_opener' }
  }
  if (!formOpen) {
    // A collapsed composer (Reddit's unnamed "Join the conversation" box) opens on a click.
    const collapsed = new Map<string, SnapshotElement>()
    for (const field of state.action.fields) {
      if (state.filled.has(field.key)) continue
      for (const element of fieldCandidates(state, field))
        if (notOpened(element)) collapsed.set(element.ref, element)
    }
    const [only] = collapsed.values()
    if (collapsed.size === 1 && only) return { op: 'click_opener', ref: agentRef(state, only) }
  }
  return { op: 'hand_off', reason: 'no_form' }
}

/**
 * The next step: approve once every field is filled, fill the first unfilled field when the
 * form is open and exactly one element fits it, otherwise open the form once. Anything else
 * hands off to the model loop.
 */
export function nextFastAction(state: FastPathState): FastAction {
  if (state.action.fields.some((field) => !state.specKeys.has(field.key)))
    return { op: 'hand_off', reason: 'missing_field' }
  if (state.action.fields.every((field) => state.filled.has(field.key))) return approve(state)

  const formOpen = commitCandidates(state).length > 0
  if (formOpen) {
    const field = state.action.fields.find((candidate) => !state.filled.has(candidate.key))
    if (field) {
      const candidates = fieldCandidates(state, field)
      const element = single(candidates)
      if (element) return { op: 'fill_field', ref: agentRef(state, element), fieldKey: field.key }
      if (candidates.length > 1) return { op: 'hand_off', reason: 'ambiguous_field' }
    }
  }
  return open(state, formOpen)
}
