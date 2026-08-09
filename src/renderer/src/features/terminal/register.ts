import { useSettingsStore } from '@renderer/features/settings'
import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { steppedFontSize, TERMINAL_FONT_STEP } from './fontSize'
import { XTERM_FONT_SIZE } from './theme'

/** The palette heading for commands that act on the terminal itself rather than on a tab. */
const TERMINAL_GROUP = 'Terminal'

/**
 * Set the terminal font size and make the choice stick. The store's write is debounced for the
 * sake of a slider drag; a keypress has no pointer-up to settle on, so it flushes the write
 * itself and the size is still there after a quit.
 */
function applyFontSize(px: number): void {
  const settings = useSettingsStore.getState()
  settings.setTerminalFontSize(px)
  settings.commitTerminalFontSize()
}

function zoom(delta: number): void {
  applyFontSize(steppedFontSize(useSettingsStore.getState().terminalFontSize, delta))
}

/**
 * Registers the terminal slice's font zoom commands. Zoom is app-wide and goes through the
 * settings store, so every open terminal restyles at once, the Settings slider keeps telling the
 * truth, and the chosen size outlives the session.
 */
export function registerTerminalFeature(): void {
  registerCommand({
    id: 'terminal.fontIncrease',
    title: 'Increase Terminal Font',
    group: TERMINAL_GROUP,
    keywords: ['zoom', 'bigger', 'larger', 'text', 'size'],
    handler: () => zoom(TERMINAL_FONT_STEP)
  })
  registerCommand({
    id: 'terminal.fontDecrease',
    title: 'Decrease Terminal Font',
    group: TERMINAL_GROUP,
    keywords: ['zoom', 'smaller', 'text', 'size'],
    handler: () => zoom(-TERMINAL_FONT_STEP)
  })
  registerCommand({
    id: 'terminal.fontReset',
    title: 'Reset Terminal Font',
    group: TERMINAL_GROUP,
    keywords: ['zoom', 'default', 'text', 'size'],
    handler: () => applyFontSize(XTERM_FONT_SIZE)
  })
}
