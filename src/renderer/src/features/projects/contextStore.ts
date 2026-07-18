import { create } from 'zustand'

/** The entry points inside one project context; Terminals is the daily default. */
export const PROJECT_TABS = ['terminals', 'kanban', 'prs', 'worktrees', 'overview'] as const
export type ProjectTabId = (typeof PROJECT_TABS)[number]

/** The stable store key for a context: a project id, or the virtual Other bucket. */
export const OTHER_CONTEXT_KEY = '__other__'

/**
 * Per-context UI state of the project shell: which entry tab is open and which workspace the
 * terminal area last showed, so re-entering a project restores the exact working spot. Session
 * UI state only - tabs/layout/focus inside a workspace are persisted by their own slices.
 */
interface ProjectContextState {
  activeTab: Record<string, ProjectTabId>
  lastWorkspace: Record<string, string>
  setTab(contextKey: string, tab: ProjectTabId): void
  rememberWorkspace(contextKey: string, workspaceId: string): void
}

export const useProjectContextStore = create<ProjectContextState>()((set) => ({
  activeTab: {},
  lastWorkspace: {},

  setTab(contextKey, tab) {
    set((s) => ({ activeTab: { ...s.activeTab, [contextKey]: tab } }))
  },

  rememberWorkspace(contextKey, workspaceId) {
    set((s) =>
      s.lastWorkspace[contextKey] === workspaceId
        ? s
        : { lastWorkspace: { ...s.lastWorkspace, [contextKey]: workspaceId } }
    )
  }
}))

/** The open entry tab of a context (Terminals until the user picks another). */
export function contextTab(state: ProjectContextState, contextKey: string): ProjectTabId {
  return state.activeTab[contextKey] ?? 'terminals'
}
