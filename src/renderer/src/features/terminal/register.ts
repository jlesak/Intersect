import { useSettingsStore } from '@renderer/features/settings'
import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { useFindStore } from './findStore'
import { resolveFindSession } from './findShortcut'
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
    id: 'terminal.find',
    title: 'Find in Terminal',
    group: TERMINAL_GROUP,
    keywords: ['search', 'scrollback', 'grep', 'output'],
    // The key that reaches this is bound by the terminal area itself rather than by the menu, so
    // this entry is where a user finds out it exists at all - and the way in when the keyboard is
    // somewhere the terminal area does not listen.
    enabled: () => resolveFindSession(null) !== null,
    handler: () => {
      const sessionId = resolveFindSession(null)
      if (sessionId) useFindStore.getState().openFind(sessionId)
    }
  })
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
