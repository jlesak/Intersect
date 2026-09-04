import type { DatabaseSync } from 'node:sqlite'
import { type WireRoutes } from '@common/coreBridge'
import {
  DEFAULT_SIDEBAR_LAYOUT,
  SIDEBAR_PANEL_MAX,
  SIDEBAR_PANEL_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  type SidebarLayout
} from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import { SELECTED_WORKSPACE_KEY, type AppStateRepo } from '../db/appStateRepo'
import type { TabRepo } from '../db/tabRepo'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import { tx } from '../db/tx'

/**
 * The core's half of the system surface. Everything else under `system:` is native and answered by
 * Electron main; this one has to reach the database, which only the core process may open.
 */
export type SystemCoreHandlers = Pick<
  IpcApi['system'],
  'resetViewState' | 'getSidebarLayout' | 'setSidebarLayout'
>

/** app_state key holding the sidebar's user-set sizes. */
export const SIDEBAR_LAYOUT_KEY = 'shell.sidebar_layout'

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)))

/**
 * A stored size is only used when it is a finite number inside its bounds; anything else - a
 * missing key, a corrupt document, a hand-edited string, a value from a future version - falls back
 * to the default rather than producing a sidebar with no room for its controls.
 */
function readPanel(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return clamp(value, SIDEBAR_PANEL_MIN, SIDEBAR_PANEL_MAX)
}

export function parseSidebarLayout(raw: string | null): SidebarLayout {
  let doc: Record<string, unknown> | null = null
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') doc = parsed as Record<string, unknown>
  } catch {
    doc = null
  }
  const width = doc?.width
  return {
    width:
      typeof width === 'number' && Number.isFinite(width)
        ? clamp(width, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
        : DEFAULT_SIDEBAR_LAYOUT.width,
    railHeight: readPanel(doc?.railHeight),
    usageHeight: readPanel(doc?.usageHeight)
  }
}

export interface SystemCoreHandlerDeps {
  db: DatabaseSync
  workspaces: WorkspaceRepo
  tabs: TabRepo
  appState: AppStateRepo
}

/**
 * The last-resort escape for a window that crashes the same way on every boot.
 *
 * Which rows this clears is the whole design. A boot restores a workspace, mounts its pane layout,
 * and fills the panes from the tab grouping, so those columns are the persisted state a render
 * crash can be deterministic on. They are also the cheapest to lose: a layout is one click to
 * rebuild, whereas a tab, a terminal, a project or a settings value is accumulated work and stays
 * exactly where it was. So the blast radius stops at the view columns, and the user is told the
 * whole list before they agree to it.
 *
 * `regroup` runs the same authoritative transform a layout change already uses, which renumbers
 * every tab into the single surviving pane group without dropping or reordering one.
 */
export function createSystemCoreHandlers(d: SystemCoreHandlerDeps): SystemCoreHandlers {
  return {
    async getSidebarLayout() {
      return parseSidebarLayout(d.appState.get(SIDEBAR_LAYOUT_KEY))
    },

    async setSidebarLayout(layout) {
      // Clamped on the way in as well as on the way out: what the renderer sends is bounded by the
      // window it measured, which says nothing about the window the next launch opens in.
      const clean = parseSidebarLayout(JSON.stringify(layout))
      d.appState.set(SIDEBAR_LAYOUT_KEY, JSON.stringify(clean))
      return clean
    },

    async resetViewState() {
      // One transaction: a crash part-way through would otherwise leave a workspace claiming a
      // four-pane grid while its tabs had already collapsed into one group.
      tx(d.db, () => {
        for (const workspace of d.workspaces.list()) {
          d.tabs.regroup(workspace.id, workspace.layout, 'single')
          d.workspaces.setLayout(workspace.id, 'single')
          d.workspaces.setActiveTab(workspace.id, null)
        }
        d.db.prepare('DELETE FROM project_terminal_layouts').run()
        // The remembered workspace is what turns a single crashing view into a crash on every
        // launch, so clearing it is the one change that decides where the next boot lands.
        d.appState.set(SELECTED_WORKSPACE_KEY, null)
        // Sidebar sizes are view state too, and a sidebar dragged to something unusable is exactly
        // the kind of state this escape exists to undo.
        d.appState.set(SIDEBAR_LAYOUT_KEY, null)
      })
    }
  }
}

export function systemWireRoutes(h: SystemCoreHandlers): WireRoutes {
  return {
    [Channel.systemResetViewState]: h.resetViewState,
    [Channel.systemGetSidebarLayout]: h.getSidebarLayout,
    [Channel.systemSetSidebarLayout]: h.setSidebarLayout
  }
}
