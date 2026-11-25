import type { Workspace } from '@common/domain'
import { useSessionsStore, type ResumeRequest } from '@renderer/features/sessions'
import { listTabsByWorkspace, useTabsStore } from '@renderer/features/tabs'
import { selectWorkspaceList, useWorkspacesStore } from '@renderer/features/workspaces'
import { reportError, useToastStore } from '@renderer/shared/ui/toast'
import { revealWorkspaceContext } from './attentionWiring'
import { waitForTabsReady } from './waitForTabsReady'

/**
 * The workspace whose folder is the session's cwd, creating one if none exists yet. A workspace is
 * just a named reference to a folder, so resuming a session from any past directory always has a
 * home to open its terminal in.
 */
async function findOrCreateWorkspace(cwd: string): Promise<Workspace | null> {
  const existing = selectWorkspaceList(useWorkspacesStore.getState()).find((w) => w.folderPath === cwd)
  if (existing) return existing
  return useWorkspacesStore.getState().create(cwd)
}

/**
 * A card request first selects an Intersect Claude tab already carrying this session id. Other
 * requests, and cards with no match, use the existing cwd workspace and new-tab resume path.
 * Newly created tabs persist the resume id and use the request's title.
 */
async function resume(summary: ResumeRequest): Promise<boolean> {
  if (summary.origin === 'card') {
    for (const existing of selectWorkspaceList(useWorkspacesStore.getState())) {
      const match = (await listTabsByWorkspace(existing.id)).find(tab =>
        tab.preset === 'claude' && tab.resumeSessionId === summary.id)
      if (!match) continue
      revealWorkspaceContext(existing.id)
      if (useWorkspacesStore.getState().selectedWorkspaceId !== existing.id) {
        await useWorkspacesStore.getState().select(existing.id)
      }
      await waitForTabsReady(existing.id)
      if (useTabsStore.getState().workspaceId !== existing.id) return false
      await useTabsStore.getState().setActiveTab(match.id)
      useTabsStore.getState().requestReveal(match.id)
      return true
    }
  }
  const ws = await findOrCreateWorkspace(summary.cwd)
  if (!ws) return false
  revealWorkspaceContext(ws.id)
  if (useWorkspacesStore.getState().selectedWorkspaceId !== ws.id) {
    await useWorkspacesStore.getState().select(ws.id)
  }
  await waitForTabsReady(ws.id)
  if (useTabsStore.getState().workspaceId !== ws.id) return false
  const tab = await useTabsStore.getState().createTab('claude', summary.id)
  if (!tab) return false
  if (summary.title) await useTabsStore.getState().renameTab(tab.id, summary.title)
  return true
}

/**
 * Wire the sessions slice's resume intent to the workspaces/tabs slices. The sessions slice stays
 * isolated - it only records a `pendingResume` request; this app-layer coordinator performs the
 * cross-slice work, publishes it as in-progress while it runs, and says how it ended. Resumes run
 * one at a time so a double-click cannot open two tabs for the same session; a request that
 * arrives while one is running is refused out loud rather than dropped, because the click that
 * made it looked like it worked. Runs once for the renderer's lifetime; returns its teardown.
 */
export function wireSessionResume(): () => void {
  let inFlight = false
  return useSessionsStore.subscribe((state, prev) => {
    const summary = state.pendingResume
    if (!summary || summary === prev.pendingResume) return
    useSessionsStore.getState().clearResume()
    if (inFlight) {
      useToastStore.getState().push('Another session is still being resumed')
      return
    }
    inFlight = true
    useSessionsStore.getState().markResuming(summary.id)
    void resume(summary)
      .then((opened) => {
        if (opened) useToastStore.getState().push(`Resumed ${summary.title}`)
        else reportError('Could not resume this session', '')
      })
      .catch((e) => reportError('Could not resume this session', e))
      .finally(() => {
        inFlight = false
        useSessionsStore.getState().markResuming(null)
      })
  })
}
