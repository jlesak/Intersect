import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconFolder } from '@renderer/shared/ui/icons'
import { WorkspaceList } from './components/WorkspaceList'
import { WorkspaceView } from './components/WorkspaceView'
import { useWorkspacesStore } from './store'

/** Registers the workspaces sidebar section (owning the main area) and its commands. */
export function registerWorkspacesFeature(): void {
  registerSidebarSection({
    id: 'workspaces',
    order: 0,
    label: 'Workspaces',
    icon: IconFolder,
    component: WorkspaceList,
    mainComponent: WorkspaceView
  })
  registerCommand({
    id: 'workspaces.create',
    title: 'Add Workspace',
    handler: async () => {
      const path = await useWorkspacesStore.getState().pickFolder()
      if (path) await useWorkspacesStore.getState().create(path)
    }
  })
}
