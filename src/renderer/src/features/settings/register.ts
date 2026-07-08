import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconSettings } from '@renderer/shared/ui/icons'
import { SettingsView } from './components/SettingsView'
import { SidebarSettings } from './components/SidebarSettings'

/**
 * Registers the Settings sidebar section (owning the main area), pinned to the sidebar footer
 * away from the daily-use sections. It deliberately has no command.
 */
export function registerSettingsFeature(): void {
  registerSidebarSection({
    id: 'settings',
    order: 100,
    label: 'Settings',
    icon: IconSettings,
    component: SidebarSettings,
    mainComponent: SettingsView,
    placement: 'footer'
  })
}
