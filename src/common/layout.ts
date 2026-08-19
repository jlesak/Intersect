import type { Layout, Tab } from './domain'

/** A tab's group placement: which pane group it belongs to and its position inside that group. */
export interface GroupAssignment {
  id: string
  paneSlot: number
  sortOrder: number
}

/** Number of visible panes - and therefore tab groups - a layout has. */
export function slotCount(layout: Layout): number {
  if (layout === 'grid') return 4
  if (layout === 'columns' || layout === 'rows') return 2
  return 1
}

/**
 * Which group's tab bar carries the workspace tools (layout picker, all-tabs overflow). It is the
 * top-right group of each layout, so the tools sit in the stage's top-right corner whatever the
 * split, the way VS Code anchors its editor-group actions.
 */
export function toolsSlot(layout: Layout): number {
  return layout === 'columns' || layout === 'grid' ? 1 : 0
}

/**
 * Where each group of `from` lands in `to` when the layout changes. Shrinking merges the groups
 * that disappear into the surviving one that holds their screen position, so no tab is ever
 * hidden or lost: the left column stays left, the top row stays top, and everything collapses
 * into group 0 under `single`. Growing keeps every group where it is and leaves the new groups
 * empty for the user to fill.
 */
export function remapSlots(from: Layout, to: Layout): number[] {
  const source = slotCount(from)
  const target = slotCount(to)
  if (target === 1) return Array.from({ length: source }, () => 0)
  if (from === 'grid' && to === 'columns') return [0, 1, 0, 1]
  if (from === 'grid' && to === 'rows') return [0, 0, 1, 1]
  // Growing two rows into the grid is the one case where the group indices themselves move: the
  // bottom pane is grid slot 2, so an identity map would throw it up to the top right.
  if (from === 'rows' && to === 'grid') return [0, 2]
  // Everything else keeps its index, which is already the same screen position: two columns become
  // the grid's top row, and columns and rows map onto each other one for one. Anything beyond the
  // target's range clamps into the last group rather than vanishing.
  return Array.from({ length: source }, (_, slot) => Math.min(slot, target - 1))
}

/**
 * The single authoritative transform from (tabs, from-layout, to-layout) to group placements.
 * It runs on the one event that can put a tab in a group its layout does not have - the layout
 * change - and the result is persisted there and then, so what the renderer loads is already
 * reconciled and load-time rendering has nothing left to decide.
 *
 * Tabs keep their relative order throughout: inside a target group, the tabs that were already
 * there come first (lowest source slot wins), then the merged-in ones, and `sortOrder` is
 * renumbered from 0 across the result so a group's bar order is exactly its `sortOrder` order.
 */
export function regroupTabs(tabs: Tab[], from: Layout, to: Layout): GroupAssignment[] {
  const map = remapSlots(from, to)
  const target = slotCount(to)
  const groups: Tab[][] = Array.from({ length: target }, () => [])

  // Sorting by (source slot, sortOrder) is what makes a merge an append: every tab of the
  // surviving group is seen before any tab of the group being folded into it.
  const ordered = [...tabs].sort((a, b) => a.paneSlot - b.paneSlot || a.sortOrder - b.sortOrder)
  for (const tab of ordered) {
    const slot = map[tab.paneSlot] ?? Math.min(Math.max(tab.paneSlot, 0), target - 1)
    groups[slot].push(tab)
  }

  return groups.flatMap((group, slot) =>
    group.map((tab, index) => ({ id: tab.id, paneSlot: slot, sortOrder: index }))
  )
}

/**
 * The tab a group currently shows: the one activated most recently, falling back to the first in
 * bar order for a group nobody has touched yet. Undefined only when the group is empty.
 */
export function visibleTabOf(groupTabs: Tab[]): Tab | undefined {
  let best: Tab | undefined
  for (const tab of groupTabs) {
    if (tab.lastActiveAt === null) continue
    if (!best || tab.lastActiveAt > (best.lastActiveAt ?? -1)) best = tab
  }
  return best ?? [...groupTabs].sort((a, b) => a.sortOrder - b.sortOrder)[0]
}
