import { makeSessionId, parseSessionId } from '@common/ipc'
import { useAttentionStore } from '@renderer/features/attention'
import { useTabsStore } from '@renderer/features/tabs'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { onNotificationClicked, onSessionStatus, reportActiveSession } from '@renderer/features/terminal'
import { useShellStore } from './shellStore'

const WORKSPACES_SECTION = 'workspaces'

/**
 * The session the user is actively viewing: the active tab of the selected workspace while the
 * Workspaces section is on screen and its tabs have loaded. Null whenever no terminal is in view
 * (another section is open, nothing selected, or tabs still loading), so a background session's
 * signal is never mistaken for one the user is already watching.
 */
function currentActiveSession(): string | null {
  // activeSectionId === null resolves to the first main-owning section, which is Workspaces.
  const section = useShellStore.getState().activeSectionId
  if (section !== null && section !== WORKSPACES_SECTION) return null
  const wsId = useWorkspacesStore.getState().selectedWorkspaceId
  const tabs = useTabsStore.getState()
  if (!wsId || tabs.status !== 'ready' || tabs.workspaceId !== wsId || !tabs.activeTabId) return null
  return makeSessionId(wsId, tabs.activeTabId)
}

/** Resolve once the tabs store is hydrated for the given workspace (with a safety timeout). */
function waitForTabsReady(workspaceId: string): Promise<void> {
  const ready = (): boolean => {
    const t = useTabsStore.getState()
    return t.status === 'ready' && t.workspaceId === workspaceId
  }
  if (ready()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe()
      resolve()
    }, 3000)
    const unsubscribe = useTabsStore.subscribe(() => {
      if (!ready()) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

/** Focus the workspace/tab a clicked notification points at, hydrating the workspace if needed. */
async function navigateToSession(sessionId: string): Promise<void> {
  const parsed = parseSessionId(sessionId)
  if (!parsed) return
  useShellStore.getState().setActiveSection(WORKSPACES_SECTION)
  const workspaces = useWorkspacesStore.getState()
  if (workspaces.selectedWorkspaceId !== parsed.workspaceId) {
    await workspaces.select(parsed.workspaceId)
  }
  await waitForTabsReady(parsed.workspaceId)
  if (useTabsStore.getState().workspaceId === parsed.workspaceId) {
    await useTabsStore.getState().setActiveTab(parsed.tabId)
  }
}

/**
 * Wire the renderer side of session attention: mirror main's alerts into the pulse store, report
 * the viewed session back to main (which clears its pending alert), and handle notification clicks.
 * Runs once for the renderer's lifetime.
 */
export function wireAttention(): void {
  onSessionStatus(({ sessionId, status }) => useAttentionStore.getState().mark(sessionId, status))
  onNotificationClicked(({ sessionId }) => void navigateToSession(sessionId))

  let lastReported: string | null | undefined
  const syncActive = (): void => {
    const active = currentActiveSession()
    if (active === lastReported) return
    lastReported = active
    reportActiveSession(active)
    if (active) useAttentionStore.getState().acknowledge(active)
  }

  useShellStore.subscribe(syncActive)
  useWorkspacesStore.subscribe(syncActive)
  useTabsStore.subscribe(syncActive)
  syncActive()

  // Returning focus to the app counts as viewing the active session, even when nothing else
  // changed - so a pulse raised while the app was in the background clears the moment the user
  // comes back to that same tab (main clears its pending alert via the re-report).
  window.addEventListener('focus', () => {
    const active = currentActiveSession()
    if (!active) return
    useAttentionStore.getState().acknowledge(active)
    reportActiveSession(active)
  })
}
