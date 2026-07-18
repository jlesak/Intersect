import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { useWorkspacesStore } from './store'

/**
 * Registers the workspaces slice's commands. The slice no longer owns a sidebar section: the
 * terminal experience lives inside each project context (and the virtual Other bucket), so the
 * rail shows project pins instead of a global Claude Code entry.
 */
export function registerWorkspacesFeature(): void {
  registerCommand({
    id: 'workspaces.create',
    title: 'Add Workspace',
    handler: async () => {
      const path = await useWorkspacesStore.getState().pickFolder()
      if (path) await useWorkspacesStore.getState().create(path)
    }
  })
}
