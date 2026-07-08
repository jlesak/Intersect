import type { ComponentType } from 'react'

/**
 * Descriptor a feature slice pushes into the sidebar registry. `component` renders inside
 * the sidebar rail; the optional `mainComponent` lets a section own the main content area
 * (the deliberate seam for future slices - e.g. a PR-review inbox - to claim the main
 * region without editing the app shell).
 */
export interface SidebarSection {
  id: string
  order: number
  label: string
  icon: ComponentType
  component: ComponentType
  mainComponent?: ComponentType
  /**
   * Where the section's rail button lives: among the daily-use sections (default 'rail') or
   * pinned to the sidebar's bottom ('footer', for utilities like Settings).
   */
  placement?: 'rail' | 'footer'
}

const sections: SidebarSection[] = []

/**
 * Register a sidebar section. Throws if a section with the same id is already registered,
 * so a double-registration bug surfaces loudly at boot instead of rendering duplicates.
 */
export function registerSidebarSection(section: SidebarSection): void {
  if (sections.some((s) => s.id === section.id)) {
    throw new Error(`Sidebar section "${section.id}" is already registered`)
  }
  sections.push(section)
}

/** All registered sections, sorted by ascending order. Returns a fresh array each call. */
export function getSidebarSections(): SidebarSection[] {
  return [...sections].sort((a, b) => a.order - b.order)
}

/** Test-only: clear the module-level registry between tests. */
export function __resetSidebarRegistryForTests(): void {
  sections.length = 0
}
