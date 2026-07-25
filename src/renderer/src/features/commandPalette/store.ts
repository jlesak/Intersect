import { createStore } from '@renderer/shared/store/createStore'

/**
 * Whether the command palette overlay is showing. It lives in a store rather than the component
 * because the native menu opens the palette from outside React, and local state cannot be reached
 * from there.
 */
interface CommandPaletteState {
  open: boolean
  toggle(): void
  close(): void
}

export const useCommandPaletteStore = createStore<CommandPaletteState>()((set) => ({
  open: false,

  toggle() {
    set((s) => ({ open: !s.open }))
  },

  close() {
    set({ open: false })
  }
}))
