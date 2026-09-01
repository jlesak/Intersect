import type { ClaudeUsage } from '@common/domain'
import { createStore } from '@renderer/shared/store/createStore'
import * as api from './ipc'

interface UsageState {
  /** The last captured Claude Code rate-limit snapshot, or null before the first one arrives. */
  usage: ClaudeUsage | null
  /** Fetch the current snapshot once, at boot. */
  hydrate(): Promise<void>
  /** True while a live query is in flight, so the refresh button can show it is working. */
  refreshing: boolean
  /** Ask Anthropic for the current usage, on boot and whenever the user hits the button. */
  refresh(): Promise<void>
  /** Listen for fresh snapshots pushed from main; returns an unsubscribe fn. */
  subscribe(): () => void
}

/**
 * The Claude usage sidebar panel's state: a single snapshot, always visible, with no error UI of
 * its own - a fetch failure or a snapshot that has not arrived yet both read the same way (null),
 * which the panel shows as its quiet "no data yet" hint. A failed refresh keeps the snapshot the
 * panel already had, since a stale reading beats blanking the panel over a transient failure.
 */
export const useUsageStore = createStore<UsageState>()((set, get) => ({
  usage: null,
  refreshing: false,

  async hydrate() {
    try {
      set({ usage: await api.get() })
    } catch {
      set({ usage: null })
    }
    // The cached snapshot paints immediately; the live query then corrects it, which matters
    // because the cached one can be days old (it only moves when a Claude session runs in-app).
    await get().refresh()
  },

  async refresh() {
    set({ refreshing: true })
    try {
      const usage = await api.refresh()
      // Null means the live query had nothing to offer (no token, endpoint unreachable), so the
      // core is telling us to keep what we have rather than to forget it.
      if (usage) set({ usage })
    } catch {
      // Same treatment: an unreachable core is not a reason to blank the panel.
    } finally {
      set({ refreshing: false })
    }
  },

  subscribe() {
    return api.onUsageChanged((usage) => set({ usage }))
  }
}))
