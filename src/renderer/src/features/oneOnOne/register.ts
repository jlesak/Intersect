import { registerCapture } from '@renderer/shared/registries/captureRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconPeople } from '@renderer/shared/ui/icons'
import { reportError, useToastStore } from '@renderer/shared/ui/toast'
import { OneOnOneView } from './components/OneOnOneView'
import { SidebarOneOnOne } from './components/SidebarOneOnOne'
import { useOneOnOneStore } from './store'

/**
 * Registers the 1:1 sidebar section (owning the main area) and the `1:1:` quick capture. The
 * section still has no palette command of its own.
 *
 * The capture starts a **prep** run, never a process run: processing a conversation needs the VTT
 * recording of it, and a capture that stops to open a file dialog is not a capture. Prep needs
 * only the name, which is exactly what one line can carry.
 */
export function registerOneOnOneFeature(): void {
  registerSidebarSection({
    id: 'oneOnOne',
    order: 10,
    label: '1:1',
    icon: IconPeople,
    component: SidebarOneOnOne,
    mainComponent: OneOnOneView
  })
  registerCapture({
    prefix: '1:1:',
    hint: 'Prepare for a 1:1 - "1:1: Marek"',
    preview: (rest) => (rest === '' ? null : `Prepare a 1:1 briefing for ${rest}`),
    async run(rest) {
      if (rest === '') return
      try {
        await useOneOnOneStore.getState().start({ type: 'prep', person: rest })
        // A prep run works in the background for a while; without this the palette would simply
        // close and nothing would suggest anything had been started.
        useToastStore.getState().push(`Preparing a 1:1 briefing for ${rest}.`)
      } catch (e) {
        reportError('Could not start the 1:1 prep', e)
      }
    }
  })
}
