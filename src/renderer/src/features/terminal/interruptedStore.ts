import { create } from 'zustand'

/**
 * Sessions whose PTY died with a core crash. Their xterms (and scrollback) stay alive, but
 * the process behind them is gone and must never be presented as running - each pane shows
 * an explicit recovery action instead. Cleared per session when the user respawns it.
 * Renderer-only UI state, keyed by the full `${workspaceId}:${tabId}` session id.
 */
interface InterruptedState {
  interrupted: Record<string, true>
  markMany(sessionIds: string[]): void
  clear(sessionId: string): void
}

export const useInterruptedStore = create<InterruptedState>()((set) => ({
  interrupted: {},

  markMany(sessionIds) {
    if (sessionIds.length === 0) return
    set((s) => {
      const next = { ...s.interrupted }
      for (const id of sessionIds) next[id] = true
      return { interrupted: next }
    })
  },

  clear(sessionId) {
    set((s) => {
      if (!(sessionId in s.interrupted)) return s
      const next = { ...s.interrupted }
      delete next[sessionId]
      return { interrupted: next }
    })
  }
}))
