import { create } from 'zustand'
import type { ClaudeUsage } from '@common/domain'
import * as api from './ipc'

interface UsageState {
  /** The last captured Claude Code rate-limit snapshot, or null before the first one arrives. */
  usage: ClaudeUsage | null
  /** Fetch the current snapshot once, at boot. */
  hydrate(): Promise<void>
  /** Listen for fresh snapshots pushed from main; returns an unsubscribe fn. */
  subscribe(): () => void
}

/**
 * The Claude usage sidebar panel's state: a single snapshot, always visible, with no loading/error
 * UI of its own - a fetch failure or a snapshot that has not arrived yet both read the same way
 * (null), which the panel shows as its quiet "no data yet" hint.
 */
export const useUsageStore = create<UsageState>()((set) => ({
  usage: null,

  async hydrate() {
    try {
      set({ usage: await api.get() })
    } catch {
      set({ usage: null })
    }
  },

  subscribe() {
    return api.onUsageChanged((usage) => set({ usage }))
  }
}))
