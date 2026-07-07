import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconPeople } from '@renderer/shared/ui/icons'
import { OneOnOneView } from './components/OneOnOneView'
import { SidebarOneOnOne } from './components/SidebarOneOnOne'

/** Registers the 1:1 sidebar section (owning the main area). It deliberately has no command. */
export function registerOneOnOneFeature(): void {
  registerSidebarSection({
    id: 'oneOnOne',
    order: -0.25,
    label: '1:1',
    icon: IconPeople,
    component: SidebarOneOnOne,
    mainComponent: OneOnOneView
  })
}
