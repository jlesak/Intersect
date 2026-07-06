import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconHistory } from '@renderer/shared/ui/icons'
import { SessionsView } from './components/SessionsView'
import { SidebarSessions } from './components/SidebarSessions'
import { useSessionsStore } from './store'

/** Registers the Sessions sidebar section (owning the main area) and its refresh command. */
export function registerSessionsFeature(): void {
  registerSidebarSection({
    id: 'sessions',
    order: 1,
    label: 'Sessions',
    icon: IconHistory,
    component: SidebarSessions,
    mainComponent: SessionsView
  })
  registerCommand({
    id: 'sessions.refresh',
    title: 'Refresh Sessions',
    handler: () => useSessionsStore.getState().refresh()
  })
}
