import { create } from 'zustand'
import { debounce } from '@common/debounce'
import {
  equalShares,
  normalizeShares,
  sharesEqual,
  type GridShares,
  type LayoutShares,
  type PairShares,
  type ResizableLayout
} from '@common/terminalLayoutShares'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

/**
 * The persisted pane shares of the current project's terminal stage, one value per resizable
 * layout. Shares are keyed by project (the project id, or 'other' for unassigned workspaces)
 * so every project keeps its own working arrangement; `hydrate` swaps the whole set when the
 * stage moves to another project. Values are always normalized, so consumers can feed them to
 * the panel library as-is.
 */
interface LayoutRatiosState {
  projectKey: string | null
  /** True once the project's persisted shares arrived; the stage renders equal shares until then. */
  loaded: boolean
  columns: PairShares
  rows: PairShares
  grid: GridShares
  hydrate(projectKey: string): Promise<void>
  /** A drag in progress: keep the store current and schedule a debounced write. */
  preview(layout: ResizableLayout, shares: LayoutShares): void
  /** A finished interaction (pointer released, resize key pressed): persist immediately. */
  commit(layout: ResizableLayout, shares: LayoutShares): void
  /** Write any pending shares now (window blur/close, layout or project switch). */
  flush(): void
}

/** How long resize updates coalesce before a persistence write. */
export const SAVE_DELAY_MS = 500

const save = debounce((projectKey: string, layout: ResizableLayout, shares: LayoutShares) => {
  api.setTerminalLayout(projectKey, layout, shares).catch((e) => {
    reportError('Could not save the pane layout', e)
  })
}, SAVE_DELAY_MS)

const defaults = (): Pick<LayoutRatiosState, 'columns' | 'rows' | 'grid'> => ({
  columns: equalShares('columns'),
  rows: equalShares('rows'),
  grid: equalShares('grid')
})

export const useLayoutRatiosStore = create<LayoutRatiosState>()((set, get) => ({
  projectKey: null,
  loaded: false,
  ...defaults(),

  async hydrate(projectKey) {
    if (get().projectKey === projectKey) return
    // Nothing scheduled for the previous project may be dropped by the switch.
    save.flush()
    set({ projectKey, loaded: false, ...defaults() })
    let persisted: Awaited<ReturnType<typeof api.getTerminalLayouts>> = {}
    try {
      persisted = await api.getTerminalLayouts(projectKey)
    } catch (e) {
      // Equal shares still let the user resize; the next interaction retries persistence.
      reportError('Could not load the saved pane layout', e)
    }
    // A later hydrate superseded this one; its response must not overwrite the newer project.
    if (get().projectKey !== projectKey) return
    set({
      loaded: true,
      columns: normalizeShares('columns', persisted.columns),
      rows: normalizeShares('rows', persisted.rows),
      grid: normalizeShares('grid', persisted.grid)
    })
  },

  preview(layout, shares) {
    const state = get()
    if (!state.projectKey) return
    const normalized = normalizeShares(layout, shares)
    // The panel library re-reports the layout it was mounted with; an unchanged value must
    // not schedule a write or the stage would persist on every mount.
    if (sharesEqual(state[layout], normalized)) return
    set({ [layout]: normalized } as Partial<LayoutRatiosState>)
    save(state.projectKey, layout, normalized)
  },

  commit(layout, shares) {
    const state = get()
    if (!state.projectKey) return
    const normalized = normalizeShares(layout, shares)
    set({ [layout]: normalized } as Partial<LayoutRatiosState>)
    save(state.projectKey, layout, normalized)
    save.flush()
  },

  flush() {
    save.flush()
  }
}))

// A pending write must survive the window losing focus or closing mid-debounce.
if (typeof window !== 'undefined') {
  window.addEventListener('blur', () => save.flush())
  window.addEventListener('beforeunload', () => save.flush())
}
