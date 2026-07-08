import { useSettingsStore } from '@renderer/features/settings'
import { setTerminalFontSize } from '@renderer/features/terminal'

/**
 * Bridge the settings slice to the terminal slice (cross-slice, app-layer): whenever the terminal
 * font size changes - the slider moving, or the persisted value arriving at boot - restyle every
 * live xterm instance and the ones created later. Also hydrates the store at boot so the size
 * applies before the user ever opens the Settings section.
 */
export function wireSettings(): void {
  useSettingsStore.subscribe((state, prev) => {
    if (state.terminalFontSize !== prev.terminalFontSize) {
      setTerminalFontSize(state.terminalFontSize)
    }
  })
  void useSettingsStore.getState().load()
}
