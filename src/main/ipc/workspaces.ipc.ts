import type { IpcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { Layout } from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import { reconcilePanes } from '@common/layout'
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
      tx(d.db, () => {
        d.workspaces.remove(id)
        if (d.appState.get(SELECTED_WORKSPACE_KEY) === id) {
          d.appState.set(SELECTED_WORKSPACE_KEY, d.workspaces.list()[0]?.id ?? null)
        }
      })
    },

    async setLayout(id, layout) {
      return tx(d.db, () => {
        const ws = d.workspaces.setLayout(id, layout)
        const assignments = reconcilePanes(d.tabs.listByWorkspace(id), layout, ws.activeTabId)
        d.tabs.setPaneSlots(assignments)
        return ws
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

/** Binds the workspace handlers to their invoke channels. Thin; behavior lives in the factory. */
export function registerWorkspaceHandlers(ipcMain: IpcMain, h: IpcApi['workspaces']): void {
  ipcMain.handle(Channel.workspacesGetState, () => h.getState())
  ipcMain.handle(Channel.workspacesCreate, (_e, folderPath: string, name?: string) =>
    h.create(folderPath, name)
  )
  ipcMain.handle(Channel.workspacesRename, (_e, id: string, name: string) => h.rename(id, name))
  ipcMain.handle(Channel.workspacesRemove, (_e, id: string) => h.remove(id))
  ipcMain.handle(Channel.workspacesSetLayout, (_e, id: string, layout: Layout) =>
    h.setLayout(id, layout)
  )
  ipcMain.handle(Channel.workspacesSetActive, (_e, id: string) => h.setActive(id))
  ipcMain.handle(Channel.workspacesPickFolder, () => h.pickFolder())
  ipcMain.handle(Channel.workspacesAssignProject, (_e, id: string, projectId: string | null) =>
    h.assignProject(id, projectId)
  )
  ipcMain.handle(Channel.workspacesAutoAssignProject, (_e, id: string) => h.autoAssignProject(id))
}
