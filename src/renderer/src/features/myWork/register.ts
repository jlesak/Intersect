import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconMyWork } from '@renderer/shared/ui/icons'
import { MyWorkView } from './components/MyWorkView'
import { SidebarMyWork } from './components/SidebarMyWork'
import { useMyWorkStore } from './store'

/** Registers the My Work sidebar section (first in the rail, owning the main area) and its refresh command. */
export function registerMyWorkFeature(): void {
  registerSidebarSection({
    id: 'myWork',
    order: -1,
    label: 'My Work',
    icon: IconMyWork,
    component: SidebarMyWork,
    mainComponent: MyWorkView
  })
  registerCommand({
    id: 'myWork.refresh',
    title: 'Refresh My Work',
    handler: () => useMyWorkStore.getState().refresh()
  })
}
