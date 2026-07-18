import { makeSessionId, parseSessionId } from '@common/ipc'
import { useAttentionStore } from '@renderer/features/attention'
import {
  contextTab,
  OTHER_CONTEXT_KEY,
  selectActiveProjects,
  useProjectContextStore,
  useProjectsStore
} from '@renderer/features/projects'
import { useTabsStore } from '@renderer/features/tabs'
import { selectSelectedWorkspace, useWorkspacesStore } from '@renderer/features/workspaces'
import { onNotificationClicked, onSessionStatus, reportActiveSession } from '@renderer/features/terminal'
import { getSidebarSections } from '@renderer/shared/registries/sidebarRegistry'
import { resolveShellContext, useShellStore } from './shellStore'
import { waitForTabsReady } from './waitForTabsReady'

/**
 * The session the user is actively viewing: the active tab of the selected workspace while a
 * project (or Other) context is on screen with its Terminals entry open and its tabs loaded.
 * Null whenever no terminal is in view (a global section is open, another entry tab is open,
 * nothing selected, or tabs still loading), so a background session's signal is never mistaken
 * for one the user is already watching.
 */
function currentActiveSession(): string | null {
  const resolved = resolveShellContext(
    useShellStore.getState().context,
    selectActiveProjects(useProjectsStore.getState()),
    getSidebarSections(),
    selectSelectedWorkspace(useWorkspacesStore.getState())
  )
  if (resolved?.kind !== 'project' && resolved?.kind !== 'other') return null
  const ctxKey = resolved.kind === 'project' ? resolved.id : OTHER_CONTEXT_KEY
  if (contextTab(useProjectContextStore.getState(), ctxKey) !== 'terminals') return null

  const ws = useWorkspacesStore.getState()
  const wsId = ws.selectedWorkspaceId
  const scope = resolved.kind === 'project' ? resolved.id : null
  if (!wsId || ws.byId[wsId]?.projectId !== scope) return null
  const tabs = useTabsStore.getState()
  if (tabs.status !== 'ready' || tabs.workspaceId !== wsId || !tabs.activeTabId) return null
  return makeSessionId(wsId, tabs.activeTabId)
}

/** Reveal the project (or Other) context a workspace lives in, with its Terminals entry open. */
export function revealWorkspaceContext(workspaceId: string): void {
  const ws = useWorkspacesStore.getState().byId[workspaceId]
  const projectId = ws?.projectId ?? null
  const shell = useShellStore.getState()
  if (projectId) shell.setActiveProject(projectId)
  else shell.setOtherContext()
  useProjectContextStore.getState().setTab(projectId ?? OTHER_CONTEXT_KEY, 'terminals')
}

/** Focus the workspace/tab a clicked notification points at, hydrating the workspace if needed. */
async function navigateToSession(sessionId: string): Promise<void> {
  const parsed = parseSessionId(sessionId)
  if (!parsed) return
  revealWorkspaceContext(parsed.workspaceId)
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
  useProjectsStore.subscribe(syncActive)
  useProjectContextStore.subscribe(syncActive)
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
