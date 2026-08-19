import { createStore } from '@renderer/shared/store/createStore'

/**
 * The find bar belongs to a pane rather than to the app: a split layout can carry one open bar
 * per terminal, each searching only its own scrollback. A query outlives its bar being closed so
 * that re-opening offers the last thing searched for, and nothing here outlives the session.
 * Renderer-only UI state, keyed by the full `${workspaceId}:${tabId}` session id.
 */
interface FindState {
  open: Record<string, boolean>
  query: Record<string, string>
  /** Bumped by every open request, so asking again for an open bar takes the caret back to it. */
  focusToken: Record<string, number>
  openFind(sessionId: string): void
  closeFind(sessionId: string): void
  setQuery(sessionId: string, query: string): void
  forgetSession(sessionId: string): void
}

export const useFindStore = createStore<FindState>()((set) => ({
  open: {},
  query: {},
  focusToken: {},

  openFind(sessionId) {
    set((s) => ({
      open: { ...s.open, [sessionId]: true },
      focusToken: { ...s.focusToken, [sessionId]: (s.focusToken[sessionId] ?? 0) + 1 }
    }))
  },

  closeFind(sessionId) {
    set((s) => ({ open: { ...s.open, [sessionId]: false } }))
  },

  setQuery(sessionId, query) {
    set((s) => ({ query: { ...s.query, [sessionId]: query } }))
  },

  forgetSession(sessionId) {
    set((s) => {
      if (!(sessionId in s.open) && !(sessionId in s.query)) return s
      const open = { ...s.open }
      const query = { ...s.query }
      const focusToken = { ...s.focusToken }
      delete open[sessionId]
      delete query[sessionId]
      delete focusToken[sessionId]
      return { open, query, focusToken }
    })
  }
}))
