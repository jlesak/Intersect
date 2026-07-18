import type { DatabaseSync } from 'node:sqlite'
import { type WireRoutes } from '@common/coreBridge'
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

    async create(workspaceId, preset, resumeSessionId) {
      const tab = d.tabs.create(workspaceId, preset, undefined, resumeSessionId)
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
      // Atomically enforce one-tab-per-slot: evict any other tab holding the slot, then assign.
      return tx(d.db, () => {
        if (slot !== null) {
          const tab = d.tabs.getById(id)
          if (tab) d.tabs.clearPaneSlot(tab.workspaceId, slot, id)
        }
        return d.tabs.setPaneSlot(id, slot)
      })
    },

    async setActive(workspaceId, tabId) {
      d.workspaces.setActiveTab(workspaceId, tabId)
    }
  }
}

export function tabsWireRoutes(h: IpcApi['tabs']): WireRoutes {
  return {
    [Channel.tabsListByWorkspace]: h.listByWorkspace,
    [Channel.tabsCreate]: h.create,
    [Channel.tabsRename]: h.rename,
    [Channel.tabsRemove]: h.remove,
    [Channel.tabsReorder]: h.reorder,
    [Channel.tabsAssignToPane]: h.assignToPane,
    [Channel.tabsSetActive]: h.setActive
  }
}
