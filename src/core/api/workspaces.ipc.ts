import type { DatabaseSync } from 'node:sqlite'
import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import { SELECTED_WORKSPACE_KEY, type AppStateRepo } from '../db/appStateRepo'
import type { ProjectRepo } from '../db/projectRepo'
import type { TabRepo } from '../db/tabRepo'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import { tx } from '../db/tx'
import type { ProjectPathDeps } from '../projects/resolveProject'
import { resolveProjectForPath } from '../projects/resolveProject'
import type { SessionManager } from '../pty/sessionManager'

export interface WorkspaceHandlerDeps {
  db: DatabaseSync
  workspaces: WorkspaceRepo
  tabs: TabRepo
  appState: AppStateRepo
  sessions: SessionManager
  pickFolder: () => Promise<string | null>
  projects: ProjectRepo
  pathDeps: ProjectPathDeps
}

type WorkspaceRowDeps = Pick<WorkspaceHandlerDeps, 'db' | 'workspaces' | 'tabs' | 'appState'>

/** Delete the workspace row (tabs cascade) and move the selection off it. Call inside a tx. */
function deleteWorkspaceRow(d: WorkspaceRowDeps, id: string): void {
  d.workspaces.remove(id)
  if (d.appState.get(SELECTED_WORKSPACE_KEY) === id) {
    d.appState.set(SELECTED_WORKSPACE_KEY, d.workspaces.list()[0]?.id ?? null)
  }
}

/**
 * Delete a workspace only while it has no tab, the check and the delete in one transaction:
 * the delete cascades to tab rows, so a tab opened meanwhile (one whose PTY may be live) keeps
 * its workspace. Used by a fix worktree's cleanup, which has no session left to kill. True when
 * the workspace is gone, including when it was already.
 */
export function removeWorkspaceIfEmpty(d: WorkspaceRowDeps, id: string): boolean {
  return tx(d.db, () => {
    if (!d.workspaces.getById(id)) return true
    if (d.tabs.listByWorkspace(id).length > 0) return false
    deleteWorkspaceRow(d, id)
    return true
  })
}

export function createWorkspaceHandlers(d: WorkspaceHandlerDeps): IpcApi['workspaces'] {
  return {
    async getState() {
      return {
        workspaces: d.workspaces.list(),
        selectedWorkspaceId: d.appState.get(SELECTED_WORKSPACE_KEY)
      }
    },

    async create(folderPath, name) {
      // Creating a workspace switches to it - the user just added it to use it. The folder decides
      // which project it lands in; no match means the virtual Other bucket.
      const projectId = resolveProjectForPath(folderPath, d.projects.list(), d.pathDeps)
      const ws = d.workspaces.create(folderPath, name, projectId)
      d.appState.set(SELECTED_WORKSPACE_KEY, ws.id)
      return ws
    },

    async rename(id, name) {
      return d.workspaces.rename(id, name)
    },

    async remove(id) {
      // Kill the PTYs by session-id prefix first - independent of the DB rows, which the
      // cascade is about to delete.
      d.sessions.killWorkspace(id)
      tx(d.db, () => deleteWorkspaceRow(d, id))
    },

    async setLayout(id, layout) {
      return tx(d.db, () => {
        // The merge is positional, so it needs the layout being left behind. Reading it before
        // the write is the only chance to know it.
        const previous = d.workspaces.getById(id)
        if (!previous) throw new Error(`Workspace not found: ${id}`)
        const workspace = d.workspaces.setLayout(id, layout)
        return { workspace, tabs: d.tabs.regroup(id, previous.layout, layout) }
      })
    },

    async setActive(id) {
      d.appState.set(SELECTED_WORKSPACE_KEY, id)
    },

    async pickFolder() {
      return d.pickFolder()
    },

    async assignProject(id, projectId) {
      return d.workspaces.setProject(id, projectId, 'manual')
    },

    async autoAssignProject(id) {
      const ws = d.workspaces.getById(id)
      if (!ws) throw new Error(`Workspace not found: ${id}`)
      const projectId = resolveProjectForPath(ws.folderPath, d.projects.list(), d.pathDeps)
      return d.workspaces.setProject(id, projectId, 'auto')
    }
  }
}

/**
 * The slice's wire contract. `pickFolder` is deliberately absent: it is Electron-only
 * (native dialog) and is answered by main before anything reaches the core.
 */
export function workspacesWireRoutes(h: IpcApi['workspaces']): WireRoutes {
  return {
    [Channel.workspacesGetState]: h.getState,
    [Channel.workspacesCreate]: h.create,
    [Channel.workspacesRename]: h.rename,
    [Channel.workspacesRemove]: h.remove,
    [Channel.workspacesSetLayout]: h.setLayout,
    [Channel.workspacesSetActive]: h.setActive,
    [Channel.workspacesAssignProject]: h.assignProject,
    [Channel.workspacesAutoAssignProject]: h.autoAssignProject
  }
}
