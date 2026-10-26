/** Default bound for one aria snapshot shown to the model or an operator. */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 12_000

export interface BoundedSnapshot {
  text: string
  /** Characters in the full snapshot before bounding. */
  totalChars: number
  truncated: boolean
}

/**
 * Bound an aria snapshot without splitting a line, so a truncated tree never ends in half an
 * element ref. Page content is untrusted; callers must still delimit it before any prompt.
 */
export function boundSnapshot(
  snapshot: string,
  maxChars = DEFAULT_SNAPSHOT_MAX_CHARS,
): BoundedSnapshot {
  const totalChars = snapshot.length
  if (totalChars <= maxChars) return { text: snapshot, totalChars, truncated: false }

  const cut = snapshot.lastIndexOf('\n', maxChars)
  const text = snapshot.slice(0, cut > 0 ? cut : maxChars)
  return { text, totalChars, truncated: true }
}

/** One element from an AI-mode aria snapshot, keyed by its Playwright ref. */
export interface SnapshotElement {
  /** Playwright ref (`e12`, or `f1e3` inside an iframe). */
  ref: string
  role: string
  name: string
  /** Bracketed flags other than the ref: `disabled`, `checked`, `active`, `cursor=pointer`... */
  flags: string[]
  /** Link target from a `/url:` child line, when present. */
  url?: string
}

const ELEMENT_LINE = /^(\s*)- ([a-z][a-z0-9-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)/i
const URL_LINE = /^(\s*)- \/url: (.+)$/
const FLAG = /\[([^\]]+)\]/g

function unquote(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

/** Parse the elements that carry refs. Lines without a ref are ignored. */
export function parseSnapshotElements(snapshot: string): Map<string, SnapshotElement> {
  const elements = new Map<string, SnapshotElement>()
  const stack: { indent: number; element: SnapshotElement | undefined }[] = []

  for (const line of snapshot.split('\n')) {
    const urlMatch = URL_LINE.exec(line)
    if (urlMatch) {
      const indent = urlMatch[1]?.length ?? 0
      const parent = [...stack].reverse().find((entry) => entry.indent < indent)?.element
      if (parent && parent.url === undefined) parent.url = urlMatch[2]?.trim()
      continue
    }

    const match = ELEMENT_LINE.exec(line)
    if (!match) continue
    const indent = match[1]?.length ?? 0
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? -1) >= indent) stack.pop()

    let ref: string | undefined
    const flags: string[] = []
    for (const flag of (match[4] ?? '').matchAll(FLAG)) {
      const value = flag[1] ?? ''
      if (value.startsWith('ref=')) ref = value.slice(4)
      else flags.push(value)
    }

    const element =
      ref !== undefined
        ? {
            ref,
            role: match[2] ?? '',
            name: match[3] !== undefined ? unquote(match[3]) : '',
            flags,
          }
        : undefined
    if (element) elements.set(element.ref, element)
    stack.push({ indent, element })
  }
  return elements
}

/** Most task controls listed after a cut snapshot, and the bound on each listed name/flag. */
export const CUT_CONTROLS_MAX = 20
const CUT_CONTROL_NAME_MAX_CHARS = 120
const CUT_CONTROL_FLAG_MAX_CHARS = 40

function controlLine(element: SnapshotElement, generation: number): string {
  const name =
    element.name.length > CUT_CONTROL_NAME_MAX_CHARS
      ? `${element.name.slice(0, CUT_CONTROL_NAME_MAX_CHARS - 1)}…`
      : element.name
  const flags = element.flags.map((flag) => ` [${flag.slice(0, CUT_CONTROL_FLAG_MAX_CHARS)}]`)
  return `- ${element.role}${name ? ` ${JSON.stringify(name)}` : ''}${flags.join('')} [ref=${generation}:${element.ref}]`
}

/**
 * Text after a cut snapshot (D054). Aria snapshots cover the whole page in DOM order, so a
 * composer below a long page never enters the bound however far the page scrolls. The notice
 * says so, and task controls past the cut are listed (still untrusted) so their refs are usable.
 */
function cutNotice(
  generation: number,
  bounded: BoundedSnapshot,
  elements: Map<string, SnapshotElement>,
  isTaskControl: ((element: SnapshotElement) => boolean) | undefined,
): string {
  const notice =
    `Snapshot cut at ${bounded.text.length} of ${bounded.totalChars} characters. Snapshots ` +
    'always start at the top of the page; scrolling does not change which part you see.'
  if (!isTaskControl) return notice

  const shown = new Set<string>()
  for (const match of bounded.text.matchAll(/\[ref=\d+:([a-z0-9]+)\]/gi)) shown.add(match[1] ?? '')
  const controls = [...elements.values()].filter(
    (element) => !shown.has(element.ref) && isTaskControl(element),
  )
  if (controls.length === 0) return `${notice} No controls for this task appear past the cut.`

  const listed = controls.slice(0, CUT_CONTROLS_MAX)
  const more =
    controls.length > listed.length ? ` (${controls.length - listed.length} more not listed)` : ''
  return [
    `${notice} Controls for this task past the cut, usable by ref${more}:`,
    wrapUntrusted(listed.map((element) => controlLine(element, generation)).join('\n'), {
      generation,
      part: 'task_controls',
    }),
  ].join('\n')
}

/** A snapshot as the agent sees it: refs qualified by generation, wrapped as untrusted. */
export interface AgentSnapshot {
  generation: number
  pageUrl: string
  /** Wrapped, bounded text for the model. */
  text: string
  truncated: boolean
  /** Elements by Playwright ref, from the full (unbounded) snapshot. */
  elements: Map<string, SnapshotElement>
}

const UNTRUSTED_TAG = 'untrusted_page_content'
const UNTRUSTED_TAG_PATTERN = /<\s*(\/?)\s*untrusted_page_content/gi

/**
 * Wrap page text so the prompt can tell data from instructions. Any closing tag inside the
 * content is neutralised so the page cannot end the block early.
 */
export function wrapUntrusted(
  content: string,
  attrs: Record<string, string | number | boolean>,
): string {
  const safe = content.replace(UNTRUSTED_TAG_PATTERN, `<$1\u200b${UNTRUSTED_TAG}`)
  const attributes = Object.entries(attrs)
    .map(([key, value]) => `${key}="${String(value).replaceAll('"', '&quot;')}"`)
    .join(' ')
  return `<${UNTRUSTED_TAG} ${attributes}>\n${safe}\n</${UNTRUSTED_TAG}>`
}

/** `3:e12` → `{generation: 3, ref: 'e12'}`. */
export function parseAgentRef(value: string): { generation: number; ref: string } | undefined {
  const match = /^(\d{1,6}):([a-z0-9]{1,16})$/i.exec(value.trim())
  if (!match) return undefined
  return { generation: Number(match[1]), ref: match[2] ?? '' }
}

export class StaleRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleRefError'
  }
}

/**
 * Tracks the latest snapshot of one page. Refs from any older generation are rejected, which
 * matches Playwright (refs resolve against the latest snapshot only).
 */
export class SnapshotTracker {
  private generation = 0
  private latest: AgentSnapshot | undefined

  /** `isTaskControl` picks the elements listed when a snapshot is cut (D054). */
  constructor(
    private readonly maxChars = DEFAULT_SNAPSHOT_MAX_CHARS,
    private readonly isTaskControl?: (element: SnapshotElement) => boolean,
  ) {}

  record(raw: string, pageUrl: string): AgentSnapshot {
    this.generation += 1
    const generation = this.generation
    const qualified = raw.replaceAll(/\[ref=([a-z0-9]+)\]/gi, `[ref=${generation}:$1]`)
    const bounded = boundSnapshot(qualified, this.maxChars)
    const elements = parseSnapshotElements(raw)
    const wrapped = wrapUntrusted(bounded.text, {
      generation,
      url: pageUrl,
      truncated: bounded.truncated,
    })
    this.latest = {
      generation,
      pageUrl,
      text: bounded.truncated
        ? `${wrapped}\n${cutNotice(generation, bounded, elements, this.isTaskControl)}`
        : wrapped,
      truncated: bounded.truncated,
      elements,
    }
    return this.latest
  }

  /** Invalidate refs after anything that may change the page (navigation, click, key). */
  invalidate(): void {
    this.latest = undefined
  }

  current(): AgentSnapshot | undefined {
    return this.latest
  }

  resolve(agentRef: string): SnapshotElement {
    const parsed = parseAgentRef(agentRef)
    if (!parsed)
      throw new StaleRefError(`"${agentRef}" is not a snapshot ref (expected <generation>:<ref>)`)
    if (!this.latest || parsed.generation !== this.latest.generation) {
      throw new StaleRefError(`ref ${agentRef} is from an old snapshot; take a new snapshot first`)
    }
    const element = this.latest.elements.get(parsed.ref)
    if (!element) throw new StaleRefError(`ref ${agentRef} is not in the current snapshot`)
    return element
  }
}
