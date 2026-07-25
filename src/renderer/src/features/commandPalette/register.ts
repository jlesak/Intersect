import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { useCommandPaletteStore } from './store'

/**
 * Registers the one command the palette owns: showing itself. A shortcut cannot exist without its
 * palette command, and the palette's own key is no exception.
 */
export function registerCommandPaletteFeature(): void {
  registerCommand({
    id: 'palette.open',
    title: 'Command Palette',
    handler: () => useCommandPaletteStore.getState().toggle()
  })
}
