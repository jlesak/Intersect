import { create } from 'zustand'
import type { Project, Workspace } from '@common/domain'
import type { SidebarSection } from '@renderer/shared/registries/sidebarRegistry'

/**
 * What owns the main area: a global section (Dashboard, TODO, Settings, ...), one project's
 * context (its terminals plus Kanban/PRs/Worktrees/Overview), or the virtual Other bucket
 * holding everything no project matched. Other is computed, never persisted as a project.
 */
export type ShellContext =
  | { kind: 'section'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'other' }

/**
 * App-shell state: which context owns the main area. `context` is null until the user picks one -
 * resolution falls back to the first project, else the first main-owning section (see
 * `resolveShellContext`).
 */
interface ShellState {
  context: ShellContext | null
  setActiveSection(id: string): void
  setActiveProject(id: string): void
  setOtherContext(): void
  /** When true the sidebar shrinks to its icon rail only (labels and the section panel hidden). */
  sidebarCollapsed: boolean
  toggleSidebar(): void
}

export const useShellStore = create<ShellState>()((set) => ({
  context: null,
  setActiveSection(id) {
    set({ context: { kind: 'section', id } })
  },
  setActiveProject(id) {
    set({ context: { kind: 'project', id } })
  },
  setOtherContext() {
    set({ context: { kind: 'other' } })
  },
  sidebarCollapsed: false,
  toggleSidebar() {
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
  }
}))

/**
 * Resolve which context owns the main area: the explicitly selected one (dropping a stale
 * project selection, e.g. after archive/delete), else the selected workspace's home context
 * (so boot restores the exact terminal spot the user left), else the first project pin, else
 * the first section owning the main area, else the first registered section. The sidebar and
 * the main region both resolve through this so they never disagree.
 */
export function resolveShellContext(
  context: ShellContext | null,
  activeProjects: Project[],
  sections: SidebarSection[],
  selectedWorkspace?: Workspace
): ShellContext | null {
  if (context && (context.kind !== 'project' || activeProjects.some((p) => p.id === context.id))) {
    return context
  }
  if (selectedWorkspace) {
    if (selectedWorkspace.projectId === null) return { kind: 'other' }
    if (activeProjects.some((p) => p.id === selectedWorkspace.projectId)) {
      return { kind: 'project', id: selectedWorkspace.projectId }
    }
  }
  if (activeProjects.length > 0) return { kind: 'project', id: activeProjects[0].id }
  const section = sections.find((s) => s.mainComponent) ?? sections[0]
  return section ? { kind: 'section', id: section.id } : null
}

/** The active section under the resolved context, or undefined outside section contexts. */
export function resolveActiveSection(
  sections: SidebarSection[],
  resolved: ShellContext | null
): SidebarSection | undefined {
  if (resolved?.kind !== 'section') return undefined
  return sections.find((s) => s.id === resolved.id)
}
