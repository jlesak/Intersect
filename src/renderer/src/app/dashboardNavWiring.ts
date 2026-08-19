import { useDashboardNavStore } from '@renderer/features/dashboard'
import { PR_INBOX_SECTION_ID, usePrInboxStore } from '@renderer/features/prInbox'
import { SETTINGS_SECTION_ID } from '@renderer/features/settings'
import { navigateToSession } from './attentionWiring'
import { useShellStore } from './shellStore'

/**
 * Wire the Dashboard's rows to the slices they point at. The Dashboard stays isolated - a click only
 * records where the user wants to go; this app-layer coordinator performs the cross-slice work (same
 * pattern as wireMyWorkPrNav and wireSessionResume).
 *
 * Each request is cleared before it is acted on, so a step that fails cannot leave an intent standing
 * that replays on the next unrelated change.
 *
 * Returns an unsubscribe so a test can wire a fresh copy without accumulating listeners.
 */
export function wireDashboardNav(): () => void {
  return useDashboardNavStore.subscribe((state, prev) => {
    const pr = state.pendingPrOpen
    if (pr && pr !== prev.pendingPrOpen) {
      useDashboardNavStore.getState().clearPrOpen()
      useShellStore.getState().setActiveSection(PR_INBOX_SECTION_ID)
      void usePrInboxStore.getState().openDetail(pr.repositoryId, pr.prId)
    }

    const sessionId = state.pendingSessionGo
    if (sessionId && sessionId !== prev.pendingSessionGo) {
      useDashboardNavStore.getState().clearSessionGo()
      void navigateToSession(sessionId)
    }

    if (state.pendingSettings && !prev.pendingSettings) {
      useDashboardNavStore.getState().clearSettings()
      useShellStore.getState().setActiveSection(SETTINGS_SECTION_ID)
    }
  })
}
