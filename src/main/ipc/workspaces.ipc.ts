import type { IpcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { Layout } from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import { reconcilePanes } from '@common/layout'
import { SELECTED_WORKSPACE_KEY, type AppStateRepo } from '../db/appStateRepo'
import type { TabRepo } from '../db/tabRepo'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import { tx } from '../db/tx'
import type { SessionManager } from '../pty/sessionManager'

export interface WorkspaceHandlerDeps {
  db: DatabaseSync
  workspaces: WorkspaceRepo
  tabs: TabRepo
  appState: AppStateRepo
  sessions: SessionManager
  pickFolder: () => Promise<string | null>
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
      const ws = d.workspaces.create(folderPath, name)
      if (d.appState.get(SELECTED_WORKSPACE_KEY) === null) {
        d.appState.set(SELECTED_WORKSPACE_KEY, ws.id)
      }
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
}
