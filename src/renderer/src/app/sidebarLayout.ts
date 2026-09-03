import {
  DEFAULT_SIDEBAR_LAYOUT,
  SIDEBAR_PANEL_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  type SidebarLayout
} from '@common/domain'
import { debounce } from '@common/debounce'
import { createStore } from '@renderer/shared/store/createStore'
import { ipc } from '@renderer/shared/ipc/client'
import { reportError } from '@renderer/shared/ui/toast'

/** How long drag updates coalesce before one write reaches the database. */
export const SAVE_DELAY_MS = 400

/**
 * The sidebar's user-set sizes: its width, and the heights of the panels stacked inside it. A
 * panel's height is `null` until it is dragged, which means "size to your content" - so a profile
 * that never touches a divider gets exactly the sidebar it always had.
 *
 * Sizes are applied while dragging and written once the drag settles, because a write per pointer
 * move would be hundreds of database round trips for one gesture.
 */
interface SidebarLayoutState extends SidebarLayout {
  /** False until the saved sizes arrive; the sidebar renders its defaults until then. */
  loaded: boolean
  /**
   * True once the user has moved a divider. The dividers are live from the first paint, so a drag
   * can land while the saved sizes are still on their way; applying them then would put the user's
   * own size back to what was stored and persist that.
   */
  touched: boolean
  hydrate(): Promise<void>
  setWidth(px: number): void
  setRailHeight(px: number | null): void
  setUsageHeight(px: number | null): void
  /** Write any pending size now (used when the window is about to go away). */
  flush(): void
}

const save = debounce((layout: SidebarLayout) => {
  ipc()
    .system.setSidebarLayout(layout)
    .catch((e) => reportError('Could not save the sidebar layout', e))
}, SAVE_DELAY_MS)

const current = (s: SidebarLayoutState): SidebarLayout => ({
  width: s.width,
  railHeight: s.railHeight,
  usageHeight: s.usageHeight
})

export const useSidebarLayoutStore = createStore<SidebarLayoutState>()((set, get) => ({
  ...DEFAULT_SIDEBAR_LAYOUT,
  loaded: false,
  touched: false,

  async hydrate() {
    try {
      const layout = await ipc().system.getSidebarLayout()
      // A drag that landed while this read was in flight is the newer decision; keep it.
      set(get().touched ? { loaded: true } : { ...layout, loaded: true })
    } catch (e) {
      // Defaults still resize; the next drag retries the write.
      set({ loaded: true })
      reportError('Could not load the saved sidebar layout', e)
    }
  },

  setWidth(px) {
    const width = Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px)))
    set({ width, touched: true })
    save({ ...current(get()), width })
  },

  setRailHeight(px) {
    const railHeight = px === null ? null : Math.round(Math.max(SIDEBAR_PANEL_MIN, px))
    set({ railHeight, touched: true })
    save({ ...current(get()), railHeight })
  },

  setUsageHeight(px) {
    const usageHeight = px === null ? null : Math.round(Math.max(SIDEBAR_PANEL_MIN, px))
    set({ usageHeight, touched: true })
    save({ ...current(get()), usageHeight })
  },

  flush() {
    save.flush()
  }
}))
