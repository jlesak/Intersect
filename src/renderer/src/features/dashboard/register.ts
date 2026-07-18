import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconDashboard } from '@renderer/shared/ui/icons'
import { DashboardView } from './components/DashboardView'

/** The rail's top section id, exported for shell tests and future navigation. */
export const DASHBOARD_SECTION_ID = 'dashboard'

/** Registers the Dashboard placeholder section at the top of the icon rail. */
export function registerDashboardFeature(): void {
  registerSidebarSection({
    id: DASHBOARD_SECTION_ID,
    order: -10,
    label: 'Dashboard',
    icon: IconDashboard,
    mainComponent: DashboardView
  })
}
