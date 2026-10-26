import type { SiteAction } from './sites.js'
import { parseSnapshotElements } from './snapshot.js'

/** Exact named controls/statuses only: quoted job-description prose is not evidence. */
export function applicationStatus(
  action: SiteAction,
  snapshot: string,
  state: 'alreadyApplied' | 'success',
): boolean {
  const pattern = action.application?.[state]
  return (
    pattern !== undefined &&
    [...parseSnapshotElements(snapshot).values()].some(
      (element) =>
        ['button', 'status', 'alert', 'heading'].includes(element.role) &&
        pattern.test(element.name.trim()),
    )
  )
}
