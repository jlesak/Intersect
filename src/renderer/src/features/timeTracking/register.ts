import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconClock } from '@renderer/shared/ui/icons'
import { SidebarTimeTracking } from './components/SidebarTimeTracking'
import { TimeTrackingView } from './components/TimeTrackingView'
import { useTimeTrackingStore } from './store'
import { useAgentRuntimeStore } from './agentRuntimeStore'

/** Registers the Time Tracking sidebar section (owning the main area) and its refresh command. */
export function registerTimeTrackingFeature(): void {
  registerSidebarSection({
    id: 'timeTracking',
    order: 12,
    label: 'Time Tracking',
    icon: IconClock,
    component: SidebarTimeTracking,
    mainComponent: TimeTrackingView
  })
  registerCommand({
    id: 'timeTracking.refresh',
    title: 'Refresh Time Tracking',
    handler: async () => {
      // Refresh the worklog board and the agent-runtime supporting figures together.
      await Promise.all([
        useTimeTrackingStore.getState().refresh(),
        useAgentRuntimeStore.getState().refresh()
      ])
    }
  })
}
