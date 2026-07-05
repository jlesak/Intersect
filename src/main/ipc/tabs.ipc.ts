import type { IpcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { Preset } from '@common/domain'
import { Channel, makeSessionId, type IpcApi } from '@common/ipc'
import type { TabRepo } from '../db/tabRepo'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import { tx } from '../db/tx'
import type { SessionManager } from '../pty/sessionManager'

export interface TabHandlerDeps {
  db: DatabaseSync
  workspaces: WorkspaceRepo
  tabs: TabRepo
  sessions: SessionManager
}

export function createTabHandlers(d: TabHandlerDeps): IpcApi['tabs'] {
  return {
    async listByWorkspace(workspaceId) {
      return d.tabs.listByWorkspace(workspaceId)
    },

    async create(workspaceId, preset) {
      const tab = d.tabs.create(workspaceId, preset)
      d.workspaces.setActiveTab(workspaceId, tab.id)
      return tab
    },

    async rename(id, title) {
      return d.tabs.rename(id, title)
    },

    async remove(id) {
      const tab = d.tabs.getById(id)
      if (!tab) return
      d.sessions.kill(makeSessionId(tab.workspaceId, id))
      tx(d.db, () => {
        const ws = d.workspaces.getById(tab.workspaceId)
        d.tabs.remove(id)
        if (ws && ws.activeTabId === id) {
          const sibling = d.tabs.listByWorkspace(tab.workspaceId)[0]?.id ?? null
          d.workspaces.setActiveTab(tab.workspaceId, sibling)
        }
      })
    },

    async reorder(workspaceId, orderedIds) {
      return tx(d.db, () => d.tabs.reorder(workspaceId, orderedIds))
    },

    async assignToPane(id, slot) {
      return d.tabs.setPaneSlot(id, slot)
    },

    async setActive(workspaceId, tabId) {
      d.workspaces.setActiveTab(workspaceId, tabId)
    }
  }
}

export function registerTabHandlers(ipcMain: IpcMain, h: IpcApi['tabs']): void {
  ipcMain.handle(Channel.tabsListByWorkspace, (_e, workspaceId: string) =>
    h.listByWorkspace(workspaceId)
  )
  ipcMain.handle(Channel.tabsCreate, (_e, workspaceId: string, preset: Preset) =>
    h.create(workspaceId, preset)
  )
  ipcMain.handle(Channel.tabsRename, (_e, id: string, title: string) => h.rename(id, title))
  ipcMain.handle(Channel.tabsRemove, (_e, id: string) => h.remove(id))
  ipcMain.handle(Channel.tabsReorder, (_e, workspaceId: string, orderedIds: string[]) =>
    h.reorder(workspaceId, orderedIds)
  )
  ipcMain.handle(Channel.tabsAssignToPane, (_e, id: string, slot: number | null) =>
    h.assignToPane(id, slot)
  )
  ipcMain.handle(Channel.tabsSetActive, (_e, workspaceId: string, tabId: string) =>
    h.setActive(workspaceId, tabId)
  )
}
