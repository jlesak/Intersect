import { DEFAULT_SIDEBAR_LAYOUT, type SidebarLayout } from '@common/domain'
import { createStore } from '@renderer/shared/store/createStore'
import { ipc } from '@renderer/shared/ipc/client'
import { reportError } from '@renderer/shared/ui/toast'

/**
 * The sidebar's user-set sizes: its width, and the heights of the panels stacked inside it. A
 * panel's height is `null` until it is dragged, which means "size to your content" - so a profile
 * that never touches a divider gets exactly the sidebar it always had.
 *
 * Sizes change in memory while a gesture runs and are written once when it ends.
 */
interface SidebarLayoutState extends SidebarLayout {
  /**
   * True once the user has moved a divider. The dividers are live from the first paint, so a drag
   * can land while the saved sizes are still on their way; applying them then would put the user's
   * own size back to what was stored.
   */
  touched: boolean
  hydrate(): Promise<void>
  setWidth(px: number): void
  setRailHeight(px: number | null): void
  setUsageHeight(px: number | null): void
  /**
   * Write the sizes as they are now. A divider calls this once, when its gesture ends. Nothing is
   * written before the user has changed a size: until then the store may still hold the defaults
   * with the saved sizes on their way, and writing those would overwrite what is stored.
   */
  save(): void
}

export const useSidebarLayoutStore = createStore<SidebarLayoutState>()((set, get) => ({
  ...DEFAULT_SIDEBAR_LAYOUT,
  touched: false,

  async hydrate() {
    try {
      const layout = await ipc().system.getSidebarLayout()
      // A drag that landed while this read was in flight is the newer decision; keep it.
      if (!get().touched) set(layout)
    } catch (e) {
      // Defaults still resize; the next gesture retries the write.
      reportError('Could not load the saved sidebar layout', e)
    }
  },

  setWidth: (width) => set({ width, touched: true }),
  setRailHeight: (railHeight) => set({ railHeight, touched: true }),
  setUsageHeight: (usageHeight) => set({ usageHeight, touched: true }),

  save() {
    const { width, railHeight, usageHeight, touched } = get()
    if (!touched) return
    ipc()
      .system.setSidebarLayout({ width, railHeight, usageHeight })
      .catch((e) => reportError('Could not save the sidebar layout', e))
  }
}))
