import { createStore } from '@renderer/shared/store/createStore'
import * as api from './ipc'

/**
 * Whether the command palette overlay is showing, and which commands the user reaches for most.
 * Both live in a store rather than the component: the native menu opens the palette from outside
 * React, and the recently-used list has to outlive the overlay being unmounted.
 */
interface CommandPaletteState {
  open: boolean
  /** Command ids in most-recently-used order, as the core last reported them. */
  recentIds: string[]
  toggle(): void
  close(): void
  /** Read the persisted recently-used list once at startup. */
  hydrateRecent(): Promise<void>
  /** Note that a command was run, so the next opening leads with it. */
  recordUse(commandId: string): Promise<void>
}

export const useCommandPaletteStore = createStore<CommandPaletteState>()((set) => ({
  open: false,
  recentIds: [],

  toggle() {
    set((s) => ({ open: !s.open }))
  },

  close() {
    set({ open: false })
  },

  async hydrateRecent() {
    try {
      set({ recentIds: await api.getRecent() })
    } catch {
      // A palette that opens with no history is a smaller loss than one that fails to open, and
      // the user has nothing to act on here - the next command they run repairs the list anyway.
    }
  },

  async recordUse(commandId) {
    try {
      set({ recentIds: await api.recordUse(commandId) })
    } catch {
      // Same reasoning: the command itself already ran, and only its ordering hint is lost.
    }
  }
}))
