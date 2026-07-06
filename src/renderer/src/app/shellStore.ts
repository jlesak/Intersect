import { create } from 'zustand'
import type { SidebarSection } from '@renderer/shared/registries/sidebarRegistry'

/**
 * App-shell state introduced when a second section (PR Review) began competing for the main area.
 * The MVP shell always rendered the first main-owning section; this makes the choice explicit.
 * `activeSectionId` is null until the user picks one - resolution falls back to the first section
 * that owns the main area (see `resolveActiveSection`).
 */
interface ShellState {
  activeSectionId: string | null
  setActiveSection(id: string): void
  /** When true the sidebar shrinks to its icon rail only (labels and the section panel hidden). */
  sidebarCollapsed: boolean
  toggleSidebar(): void
}

export const useShellStore = create<ShellState>()((set) => ({
  activeSectionId: null,
  setActiveSection(id) {
    set({ activeSectionId: id })
  },
  sidebarCollapsed: false,
  toggleSidebar() {
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
  }
}))

/**
 * Resolve which section is active: the explicitly selected one, else the first section owning the
 * main area, else the first registered section. Both the sidebar rail and the main region resolve
 * through this so they never disagree.
 */
export function resolveActiveSection(
  sections: SidebarSection[],
  activeSectionId: string | null
): SidebarSection | undefined {
  return (
    sections.find((s) => s.id === activeSectionId) ??
    sections.find((s) => s.mainComponent) ??
    sections[0]
  )
}
