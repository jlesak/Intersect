import type { SessionSummary, Workspace } from '@common/domain'
import { useSessionsStore } from '@renderer/features/sessions'
import { useTabsStore } from '@renderer/features/tabs'
import { selectWorkspaceList, useWorkspacesStore } from '@renderer/features/workspaces'
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
 * Resume a past Claude Code session: reveal the terminal context of the workspace owning the
 * session's folder (its project, or Other), ensure that workspace is selected and its tabs are
 * loaded, then open a Claude tab that launches `claude --resume <id>`. The tab persists its
 * resume id, so the conversation is restored on the next launch too, and carries the session's
 * own title so it stays recognizable in the tab bar rather than reading as a generic "Claude"
 * tab.
 */
async function resume(summary: SessionSummary): Promise<void> {
  const ws = await findOrCreateWorkspace(summary.cwd)
  if (!ws) return
  revealWorkspaceContext(ws.id)
  if (useWorkspacesStore.getState().selectedWorkspaceId !== ws.id) {
    await useWorkspacesStore.getState().select(ws.id)
  }
  await waitForTabsReady(ws.id)
  if (useTabsStore.getState().workspaceId !== ws.id) return
  const tab = await useTabsStore.getState().createTab('claude', summary.id)
  if (tab && summary.title) await useTabsStore.getState().renameTab(tab.id, summary.title)
}

/**
 * Wire the sessions slice's resume intent to the workspaces/tabs slices. The sessions slice stays
 * isolated - it only records a `pendingResume` request; this app-layer coordinator performs the
 * cross-slice work. A single in-flight guard collapses a double-click into one resume so it cannot
 * open two tabs for the same session. Runs once for the renderer's lifetime.
 */
export function wireSessionResume(): void {
  let inFlight = false
  useSessionsStore.subscribe((state, prev) => {
    const summary = state.pendingResume
    if (!summary || summary === prev.pendingResume) return
    useSessionsStore.getState().clearResume()
    if (inFlight) return
    inFlight = true
    void resume(summary).finally(() => (inFlight = false))
  })
}
