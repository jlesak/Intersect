import type { DragEvent } from 'react'
import { isTabDrag, readTabDrag } from './components/tabDrag'
import { selectGroupTabs, useTabsStore } from './store'

/** The drag handlers a pane hands to whatever element covers its area. */
export interface PaneDropHandlers {
  onDragOver(e: DragEvent<HTMLElement>): void
  onDragLeave(e: DragEvent<HTMLElement>): void
  onDrop(e: DragEvent<HTMLElement>): void
}

/**
 * Makes a whole pane accept a dragged tab, not just the strip above it. A pane reads as one
 * target - most of all an empty one, which is a large blank area with a 32px strip on top - so a
 * drop anywhere inside it means "show this tab here": a tab from another group moves in and takes
 * the pane, and a tab already in this group is simply the one the pane shows from now on.
 *
 * Deliberately a plain function rather than a hook. The stage builds a pane's content once per
 * slot and the number of slots changes with the layout, so a hook here would reorder React's hook
 * list the moment the user changed the split.
 */
export function paneDropHandlers(slot: number): PaneDropHandlers {
  return {
    onDragOver(e) {
      // Anything the app did not write - a file, a text selection - slides straight past, which
      // is what leaves the browser showing the no-drop cursor for it.
      if (!isTabDrag(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      useTabsStore.getState().setDropSlot(slot)
    },

    onDragLeave(e) {
      // Crossing onto the terminal inside the pane fires a leave that must not unmark the pane.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      const state = useTabsStore.getState()
      if (state.dropSlot === slot) state.setDropSlot(null)
    },

    onDrop(e) {
      e.preventDefault()
      const drag = readTabDrag(e.dataTransfer)
      const state = useTabsStore.getState()
      state.setDropSlot(null)
      if (!drag) return
      if (drag.slot === slot) {
        void state.setActiveTab(drag.id)
        return
      }
      // The body names no position in the strip, so the tab joins at the end of the bar, and
      // moving it into another group is what makes that group show it.
      void state.moveTab(drag.id, slot, selectGroupTabs(state, slot).length)
    }
  }
}
