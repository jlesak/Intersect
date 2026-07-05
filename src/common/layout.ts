import type { Layout, Tab } from './domain'

/** A tab's pane placement under the current layout: a slot index, or null (tab-bar only). */
export interface PaneAssignment {
  id: string
  paneSlot: number | null
}

/** Number of visible panes a layout has. */
export function slotCount(layout: Layout): number {
  if (layout === 'grid') return 4
  if (layout === 'columns' || layout === 'rows') return 2
  return 1
}

/**
 * The single authoritative transform from (tabs, layout, activeTab) to pane placements.
 * Run both when the layout changes (persisted) and at load (before render) so the DB and the
 * view never disagree. Rules:
 * - single: every tab is unplaced (the one pane renders the active tab directly).
 * - multi-pane: keep each tab's in-range, non-duplicate slot; clear the rest; and if nothing is
 *   placed yet, seed slot 0 with the active tab so a freshly-split workspace is not all-empty.
 *   The active tab is only seeded when it currently has no slot, so it can never render twice.
 */
export function reconcilePanes(
  tabs: Tab[],
  layout: Layout,
  activeTabId: string | null
): PaneAssignment[] {
  const n = slotCount(layout)

  if (n === 1) {
    return tabs.map((t) => ({ id: t.id, paneSlot: null }))
  }

  const used = new Set<number>()
  const result: PaneAssignment[] = tabs.map((t) => {
    const slot = t.paneSlot
    if (slot == null || slot < 0 || slot >= n || used.has(slot)) {
      return { id: t.id, paneSlot: null }
    }
    used.add(slot)
    return { id: t.id, paneSlot: slot }
  })

  const anyPlaced = result.some((r) => r.paneSlot !== null)
  if (!anyPlaced && activeTabId !== null) {
    const target = result.find((r) => r.id === activeTabId)
    if (target) target.paneSlot = 0
  }

  return result
}
