import { create } from 'zustand'
import type { Layout, NewWorkItemRef, Preset, Tab } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { reconcilePanes } from '@common/layout'
import { useAttentionStore } from '@renderer/features/attention'
import { disposeSession } from '@renderer/features/terminal'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface TabsState {
  status: Status
  error: string | null
  workspaceId: string | null
  byId: Record<string, Tab>
  order: string[]
  layout: Layout
  activeTabId: string | null
  hydrate(workspaceId: string): Promise<void>
  clear(): void
  createTab(
    preset: Preset,
    resumeSessionId?: string | null,
    primaryWorkItem?: NewWorkItemRef | null
  ): Promise<Tab | null>
  renameTab(id: string, title: string): Promise<void>
  removeTab(id: string): Promise<void>
  reorderTabs(orderedIds: string[]): Promise<void>
  setActiveTab(id: string): Promise<void>
  setLayout(layout: Layout): Promise<void>
  assignToPane(id: string, slot: number | null): Promise<void>
  /**
   * Locally clear a tab's suspend marker once its session has been respawned, so the pane stops
   * showing the restored/resume state without waiting for a full re-hydrate. Mirrors the DB clear
   * the core performs via sessions.clearSuspended.
   */
  markResumed(id: string): void
}

/** Tabs of the current workspace in bar order. */
export function selectTabList(state: TabsState): Tab[] {
  return state.order.map((id) => state.byId[id]).filter(Boolean)
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const EMPTY = {
  status: 'idle' as Status,
  error: null,
  workspaceId: null,
  byId: {} as Record<string, Tab>,
  order: [] as string[],
  layout: 'single' as Layout,
  activeTabId: null as string | null
}

export const useTabsStore = create<TabsState>()((set, get) => ({
  ...EMPTY,

  async hydrate(workspaceId) {
    set({ ...EMPTY, status: 'loading', workspaceId })
    try {
      // Seed layout/activeTab from the workspace's freshest persisted state, then load its tabs.
      const { workspaces } = await api.workspaceState()
      const ws = workspaces.find((w) => w.id === workspaceId)
      if (!ws) {
        set({ ...EMPTY })
        return
      }
      const tabs = await api.listByWorkspace(workspaceId)
      const byId: Record<string, Tab> = {}
      for (const t of tabs) byId[t.id] = t
      set({
        status: 'ready',
        workspaceId,
        layout: ws.layout,
        activeTabId: ws.activeTabId,
        byId,
        order: tabs.map((t) => t.id)
      })
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  },

  clear() {
    set({ ...EMPTY })
  },

  async createTab(preset, resumeSessionId, primaryWorkItem) {
    const workspaceId = get().workspaceId
    if (!workspaceId) return null
    try {
      const t = await api.create(workspaceId, preset, resumeSessionId, primaryWorkItem)
      set((s) => ({ byId: { ...s.byId, [t.id]: t }, order: [...s.order, t.id], activeTabId: t.id }))
      return t
    } catch (e) {
      reportError('Could not open a terminal', e)
      return null
    }
  },

  async renameTab(id, title) {
    try {
      const t = await api.rename(id, title)
      set((s) => ({ byId: { ...s.byId, [id]: t } }))
    } catch (e) {
      reportError('Could not rename the tab', e)
    }
  },

  async removeTab(id) {
    const workspaceId = get().workspaceId
    try {
      await api.remove(id)
    } catch (e) {
      reportError('Could not close the tab', e)
      return
    }
    // Release the tab's live terminal (xterm, observer, router sink); the PTY is killed in main.
    if (workspaceId) {
      const sessionId = makeSessionId(workspaceId, id)
      disposeSession(sessionId)
      useAttentionStore.getState().remove(sessionId)
    }
    set((s) => {
      const byId = { ...s.byId }
      delete byId[id]
      const order = s.order.filter((x) => x !== id)
      const activeTabId = s.activeTabId === id ? (order[0] ?? null) : s.activeTabId
      return { byId, order, activeTabId }
    })
  },

  async reorderTabs(orderedIds) {
    const workspaceId = get().workspaceId
    if (!workspaceId) return
    try {
      const tabs = await api.reorder(workspaceId, orderedIds)
      const byId: Record<string, Tab> = {}
      for (const t of tabs) byId[t.id] = t
      set({ byId, order: tabs.map((t) => t.id) })
    } catch (e) {
      reportError('Could not reorder tabs', e)
    }
  },

  async setActiveTab(id) {
    const workspaceId = get().workspaceId
    if (!workspaceId) return
    try {
      await api.setActive(workspaceId, id)
      set({ activeTabId: id })
    } catch (e) {
      reportError('Could not switch tabs', e)
    }
  },

  async setLayout(layout) {
    const workspaceId = get().workspaceId
    if (!workspaceId) return
    try {
      const ws = await api.setLayout(workspaceId, layout)
      // Recompute pane placement locally to match what the main process persisted.
      const assignments = reconcilePanes(selectTabList(get()), ws.layout, get().activeTabId)
      set((s) => {
        const byId = { ...s.byId }
        for (const a of assignments) {
          if (byId[a.id]) byId[a.id] = { ...byId[a.id], paneSlot: a.paneSlot }
        }
        return { layout: ws.layout, byId }
      })
    } catch (e) {
      reportError('Could not change the layout', e)
    }
  },

  async assignToPane(id, slot) {
    try {
      // Main atomically evicts any other tab in this slot; mirror that locally for the UI.
      const updated = await api.assignToPane(id, slot)
      set((s) => {
        const byId = { ...s.byId }
        if (slot !== null) {
          for (const t of Object.values(byId)) {
            if (t.paneSlot === slot && t.id !== id) byId[t.id] = { ...t, paneSlot: null }
          }
        }
        byId[id] = updated
        return { byId }
      })
    } catch (e) {
      reportError('Could not place the tab', e)
    }
  },

  markResumed(id) {
    set((s) => {
      const tab = s.byId[id]
      if (!tab || tab.sessionStatus === null) return s
      return {
        byId: {
          ...s.byId,
          [id]: { ...tab, sessionStatus: null, suspendReason: null, suspendedAt: null }
        }
      }
    })
  }
}))
