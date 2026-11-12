import { registerCapture } from '@renderer/shared/registries/captureRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconNote } from '@renderer/shared/ui/icons'
import { useToastStore } from '@renderer/shared/ui/toast'
import { NotesView } from './components/NotesView'
import { useNotesStore } from './store'

/** The rail id of the Notes section. */
export const NOTES_SECTION_ID = 'notes'

/**
 * Registers the Notes section (owning the main area, with no sidebar body of its own) and the
 * `note:` quick capture, which writes a thought into today's note without leaving what the user
 * was doing.
 */
export function registerNotesFeature(): void {
  registerSidebarSection({
    id: NOTES_SECTION_ID,
    // Right after TODO (11), before Time Tracking (12).
    order: 11.5,
    label: 'Notes',
    icon: IconNote,
    mainComponent: NotesView
  })
  registerCapture({
    prefix: 'note:',
    hint: `Add to today's note - "note: call Bob about the cache"`,
    preview: (rest) => (rest === '' ? null : `Add to today's note: ${rest}`),
    async run(rest) {
      if (rest === '') return
      // The notes are not on screen when a thought is captured from elsewhere, so only a write the
      // store confirmed may be confirmed to the user. A failure has already raised its own message.
      if (!(await useNotesStore.getState().add(rest))) return
      useToastStore.getState().push("Added to today's note")
    }
  })
}
