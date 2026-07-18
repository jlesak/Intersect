import { useProjectsStore } from '@renderer/features/projects'
import { useWorkspacesStore } from '@renderer/features/workspaces'

/**
 * Keep workspace assignments in sync with project bindings. Main re-resolves every
 * auto-assigned workspace whenever a project is created, archived, removed, or its repo
 * bindings change - so after each projects reload the renderer's workspace snapshot may be
 * stale. Re-hydrating on the projects list changing keeps pins, lists, and contexts truthful.
 * Runs once for the renderer's lifetime.
 */
export function wireProjectsToWorkspaces(): void {
  useProjectsStore.subscribe((state, prev) => {
    if (state.projects === prev.projects) return
    if (useWorkspacesStore.getState().status !== 'ready') return
    void useWorkspacesStore.getState().hydrate()
  })
}
