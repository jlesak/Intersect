import { useMyWorkStore } from '@renderer/features/myWork'
import { PR_INBOX_SECTION_ID, usePrInboxStore } from '@renderer/features/prInbox'
import { useShellStore } from './shellStore'

/**
 * Wire the My Work PR radar's row clicks to the PR Inbox slice. The myWork slice stays isolated -
 * a click only records a `pendingPrOpen` intent; this app-layer coordinator switches the shell to
 * the PR Inbox section and opens the PR's detail there (same pattern as wireSessionResume).
 * Runs once for the renderer's lifetime.
 */
export function wireMyWorkPrNav(): void {
  useMyWorkStore.subscribe((state, prev) => {
    const target = state.pendingPrOpen
    if (!target || target === prev.pendingPrOpen) return
    useMyWorkStore.getState().clearPrOpen()
    useShellStore.getState().setActiveSection(PR_INBOX_SECTION_ID)
    void usePrInboxStore.getState().openDetail(target.repositoryId, target.prId)
  })
}
