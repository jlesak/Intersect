/**
 * The mechanics of dragging a tab between groups: what travels on the drag, and where under the
 * pointer it lands. Kept apart from the components because the insert-position arithmetic is the
 * part that can be wrong in ways a rendered test would never notice, and it is pure.
 */

/**
 * The private transfer type a tab drag announces itself with. A bar accepts a drop only when this
 * type is present, so a file or a selection dragged in from outside the app slides straight past.
 */
export const TAB_DRAG_MIME = 'application/x-intersect-tab'

/** The dragged tab and the group it started in, which is all a drop needs to know about it. */
export interface TabDrag {
  id: string
  slot: number
}

/**
 * The subset of DataTransfer these helpers touch. Narrowing it this way lets the drop arithmetic
 * be exercised with a plain object, because jsdom has no DataTransfer to construct.
 */
export interface TabTransfer {
  types: readonly string[]
  getData(type: string): string
  setData(type: string, value: string): void
}

/** Puts the dragged tab on the transfer, plus a plain-text fallback for drops outside the app. */
export function writeTabDrag(transfer: TabTransfer, drag: TabDrag): void {
  transfer.setData(TAB_DRAG_MIME, JSON.stringify(drag))
  transfer.setData('text/plain', drag.id)
}

/**
 * Whether a drag hovering a bar is one of our tabs. The payload itself is unreadable while the
 * drag is still moving (browsers expose only the type list until the drop), so the type list is
 * the only thing a dragover handler can decide on.
 */
export function isTabDrag(transfer: TabTransfer): boolean {
  return Array.from(transfer.types ?? []).includes(TAB_DRAG_MIME)
}

/** Reads the dragged tab back on drop, answering null for anything this app did not write. */
export function readTabDrag(transfer: TabTransfer): TabDrag | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(transfer.getData(TAB_DRAG_MIME))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { id, slot } = parsed as Record<string, unknown>
  if (typeof id !== 'string' || typeof slot !== 'number') return null
  return { id, slot }
}

/** The horizontal extent of one tab in the strip, in viewport coordinates. */
export interface TabSpan {
  left: number
  width: number
}

/**
 * The insert position a pointer at `x` names in a strip: the left half of a tab inserts before it
 * and the right half after it, so the gap the user is aiming at is the gap they get. A pointer
 * past the last tab lands at the end, which is how a drop onto a bar's empty space appends.
 */
export function dropIndexAt(spans: TabSpan[], x: number): number {
  for (let index = 0; index < spans.length; index++) {
    if (x < spans[index].left + spans[index].width / 2) return index
  }
  return spans.length
}

/**
 * The position the tab must end up at, given an insert index counted against the group as it looks
 * right now. Dragging a tab forward inside its own group is the case that needs the correction:
 * lifting it out shifts every later tab back by one, so the raw insert index would overshoot by
 * one place.
 */
export function dropTargetIndex(groupIds: string[], id: string, insertAt: number): number {
  const from = groupIds.indexOf(id)
  const last = from === -1 ? groupIds.length : groupIds.length - 1
  const wanted = from !== -1 && from < insertAt ? insertAt - 1 : insertAt
  return Math.max(0, Math.min(wanted, last))
}
