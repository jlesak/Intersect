import { createStore } from '@renderer/shared/store/createStore'

/**
 * Where the Dashboard is asking to send the user.
 *
 * The Dashboard is a reading surface over other slices, and every row on it is a way out of it. It
 * records the request and nothing more: the app layer owns the cross-slice work of switching
 * sections and revealing workspaces, so this feature never reaches into another one to navigate.
 *
 * Only ever written through actions and read with `getState()`, never subscribed to - the Dashboard
 * itself has nothing to show about a request it just made.
 */
interface DashboardNavState {
  /** The pull request whose detail to open, until the app layer has opened it. */
  pendingPrOpen: { repositoryId: string; prId: number } | null
  /** The session id to reveal, until the app layer has revealed it. */
  pendingSessionGo: string | null
  openPr(repositoryId: string, prId: number): void
  clearPrOpen(): void
  goToSession(sessionId: string): void
  clearSessionGo(): void
}

export const useDashboardNavStore = createStore<DashboardNavState>()((set) => ({
  pendingPrOpen: null,
  pendingSessionGo: null,

  openPr(repositoryId, prId) {
    set({ pendingPrOpen: { repositoryId, prId } })
  },

  clearPrOpen() {
    set({ pendingPrOpen: null })
  },

  goToSession(sessionId) {
    set({ pendingSessionGo: sessionId })
  },

  clearSessionGo() {
    set({ pendingSessionGo: null })
  }
}))
