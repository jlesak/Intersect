import type { Workspace } from '@common/domain'
import { useTabsStore } from '@renderer/features/tabs'
import { useWorkItemsStore, type WorkItemLaunch } from '@renderer/features/workItems'
import {
  selectSelectedWorkspace,
  selectWorkspaceList,
  useWorkspacesStore
} from '@renderer/features/workspaces'
import { revealWorkspaceContext } from './attentionWiring'
import { waitForTabsReady } from './waitForTabsReady'

/**
 * The workspace that should host the launched session: the one already on the requested folder
 * (creating it when none exists yet), or the currently selected workspace when the item carries
 * no folder of its own. The folder is always a project's main checkout - card launches never
 * create or pick a worktree; that stays a future explicit opt-in.
 */
async function resolveWorkspace(folderPath: string | null): Promise<Workspace | null> {
  if (folderPath === null) {
    return selectSelectedWorkspace(useWorkspacesStore.getState()) ?? null
  }
  const existing = selectWorkspaceList(useWorkspacesStore.getState()).find(
    (w) => w.folderPath === folderPath
  )
  if (existing) return existing
  return useWorkspacesStore.getState().create(folderPath)
}

/**
 * Execute one card launch: reveal and select the hosting workspace, wait for its tabs, then
 * open a Claude tab whose primary work item is written in the same transaction as the tab -
 * there is never a moment the session exists without its ref.
 */
async function launch(request: WorkItemLaunch): Promise<void> {
  const ws = await resolveWorkspace(request.folderPath)
  if (!ws) return
  revealWorkspaceContext(ws.id)
  if (useWorkspacesStore.getState().selectedWorkspaceId !== ws.id) {
    await useWorkspacesStore.getState().select(ws.id)
  }
  await waitForTabsReady(ws.id)
  if (useTabsStore.getState().workspaceId !== ws.id) return
  const tab = await useTabsStore.getState().createTab('claude', null, request.ref)
  // The tab chip reads from the work-items store; re-read so the fresh ref shows immediately.
  if (tab) await useWorkItemsStore.getState().hydrate(ws.id)
}

/**
 * Wire the work-items slice to the workspaces/tabs slices (cross-slice, app-layer): keep the
 * hydrated refs following the tabs slice's workspace, and execute recorded card-launch intents.
 * A single in-flight guard collapses a double-click into one launch. Runs once for the
 * renderer's lifetime.
 */
export function wireWorkItemLaunch(): void {
  useTabsStore.subscribe((state, prev) => {
    if (state.workspaceId === prev.workspaceId) return
    if (state.workspaceId) void useWorkItemsStore.getState().hydrate(state.workspaceId)
    else useWorkItemsStore.getState().clear()
  })

  let inFlight = false
  useWorkItemsStore.subscribe((state, prev) => {
    const request = state.pendingLaunch
    if (!request || request === prev.pendingLaunch) return
    useWorkItemsStore.getState().clearLaunch()
    if (inFlight) return
    inFlight = true
    void launch(request).finally(() => (inFlight = false))
  })
}
