import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconFolder } from '@renderer/shared/ui/icons'
import { WorkspaceList } from './components/WorkspaceList'
import { WorkspaceView } from './components/WorkspaceView'
import { useWorkspacesStore } from './store'

/** The sidebar section id for the workspaces area - the single source both app-layer coordinators
 * (attention navigation, session resume) key off when they need to reveal a live terminal. */
export const WORKSPACES_SECTION_ID = 'workspaces'

/** Registers the workspaces sidebar section (owning the main area) and its commands. */
export function registerWorkspacesFeature(): void {
  registerSidebarSection({
    id: WORKSPACES_SECTION_ID,
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
