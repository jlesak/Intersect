import { getCommand } from '@renderer/shared/registries/commandRegistry'
import { ipc } from '@renderer/shared/ipc/client'
import { reportError } from '@renderer/shared/ui/toast'

/**
 * Run the command a native menu accelerator asked for. Runs once for the renderer's lifetime.
 *
 * This is the one path that dispatches an arbitrary feature handler from an untyped string, and it
 * runs outside React's tree where no error boundary can reach it - so both an id no command claims
 * and a handler that fails are contained here and surfaced as a toast.
 */
export function wireShortcuts(): void {
  ipc().shortcuts.onInvoked((id) => {
    // The menu is built from the shortcut map while handlers come from feature registration, so an
    // id no command claims is a possible state.
    const command = getCommand(id)
    if (!command) return
    try {
      void Promise.resolve(command.handler()).catch((e) => reportError('Shortcut failed', e))
    } catch (e) {
      reportError('Shortcut failed', e)
    }
  })
}
