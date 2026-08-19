import type { DatabaseSync } from 'node:sqlite'
import { type WireRoutes } from '@common/coreBridge'
import { Channel, makeSessionId, type IpcApi } from '@common/ipc'
import { workItemTabTitle } from '@common/workItems'
import type { TabRepo } from '../db/tabRepo'
import type { WorkItemRefRepo } from '../db/workItemRefRepo'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import { tx } from '../db/tx'
import type { SessionManager } from '../pty/sessionManager'

export interface TabHandlerDeps {
  db: DatabaseSync
  workspaces: WorkspaceRepo
  tabs: TabRepo
  workItems: WorkItemRefRepo
  sessions: SessionManager
}

export function createTabHandlers(d: TabHandlerDeps): IpcApi['tabs'] {
  return {
    async listByWorkspace(workspaceId) {
      return d.tabs.listByWorkspace(workspaceId)
    },

    async create(workspaceId, preset, paneSlot, resumeSessionId, primaryWorkItem) {
      // Tab, primary work item and focus land in one transaction, so a card launch can never
      // leave a session without its ref (or a ref without its session). The item also supplies
      // the default title; renaming later never touches the ref. The activation stamp is what
      // makes the brand-new tab the one its pane shows, rather than whichever tab of that group
      // was last looked at.
      return tx(d.db, () => {
        const title = primaryWorkItem ? workItemTabTitle(primaryWorkItem) : undefined
        const created = d.tabs.create(workspaceId, preset, title, resumeSessionId, paneSlot)
        if (primaryWorkItem) d.workItems.set(created.id, primaryWorkItem)
        d.workspaces.setActiveTab(workspaceId, created.id)
        return d.tabs.touchActive(created.id, Date.now())
      })
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

    async moveTab(id, slot, index) {
      return d.tabs.moveToGroup(id, slot, index)
    },

    async setActive(workspaceId, tabId) {
      // Focus is two facts written together: the workspace's active tab (which group has focus)
      // and the tab's activation stamp (which tab that group shows).
      return tx(d.db, () => {
        d.workspaces.setActiveTab(workspaceId, tabId)
        return d.tabs.touchActive(tabId, Date.now())
      })
    }
  }
}

export function tabsWireRoutes(h: IpcApi['tabs']): WireRoutes {
  return {
    [Channel.tabsListByWorkspace]: h.listByWorkspace,
    [Channel.tabsCreate]: h.create,
    [Channel.tabsRename]: h.rename,
    [Channel.tabsRemove]: h.remove,
    [Channel.tabsMoveTab]: h.moveTab,
    [Channel.tabsSetActive]: h.setActive
  }
}
