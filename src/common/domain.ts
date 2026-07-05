/**
 * Cross-process domain model. Shared verbatim between the main process (SQLite rows),
 * the preload bridge, and the renderer stores/components. No behavior lives here - only
 * the shapes both sides must agree on.
 */

export const PRESETS = ['shell', 'claude'] as const
export type Preset = (typeof PRESETS)[number]

/** How a preset presents and launches. One entry here is all a new preset needs (plus the union). */
export interface PresetMeta {
  label: string
  badge: string
  description: string
  defaultTitle: string
  /** Typed into the resolved shell once ready; null spawns a plain shell. */
  initialCommand: string | null
}

export const PRESET_META: Record<Preset, PresetMeta> = {
  shell: {
    label: 'Shell',
    badge: 'SH',
    description: 'Your default shell',
    defaultTitle: 'Shell',
    initialCommand: null
  },
  claude: {
    label: 'Claude Code',
    badge: 'AI',
    description: 'claude in this folder',
    defaultTitle: 'Claude',
    initialCommand: 'claude'
  }
}

export const LAYOUTS = ['single', 'columns', 'rows', 'grid'] as const
export type Layout = (typeof LAYOUTS)[number]

/**
 * A workspace is a named reference to a folder on disk. It owns an ordered set of tabs,
 * a split layout, and a pointer to the focused tab. Deleting a workspace is app-state
 * only and never touches the filesystem.
 */
export interface Workspace {
  id: string
  name: string
  folderPath: string
  layout: Layout
  /** The focused tab; intentionally not a DB foreign key - reconciled by the app. */
  activeTabId: string | null
  sortOrder: number
}

/**
 * A tab belongs to a workspace and, when placed, occupies one pane slot of the current
 * layout. `preset` decides how its PTY is launched. `paneSlot` is null when the tab lives
 * only in the tab bar (not shown in a pane under the current layout).
 */
export interface Tab {
  id: string
  workspaceId: string
  title: string
  preset: Preset
  paneSlot: number | null
  sortOrder: number
}

/** Full state needed to hydrate the renderer at boot. */
export interface BootState {
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
}
