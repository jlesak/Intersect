import { create } from 'zustand'
import type { Layout, Preset, Tab } from '@common/domain'
import { reconcilePanes } from '@common/layout'
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
  createTab(preset: Preset): Promise<Tab | null>
  renameTab(id: string, title: string): Promise<void>
  removeTab(id: string): Promise<void>
  reorderTabs(orderedIds: string[]): Promise<void>
  setActiveTab(id: string): Promise<void>
  setLayout(layout: Layout): Promise<void>
  assignToPane(id: string, slot: number | null): Promise<void>
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

  async createTab(preset) {
    const workspaceId = get().workspaceId
    if (!workspaceId) return null
    const t = await api.create(workspaceId, preset)
    set((s) => ({ byId: { ...s.byId, [t.id]: t }, order: [...s.order, t.id], activeTabId: t.id }))
    return t
  },

  async renameTab(id, title) {
    const t = await api.rename(id, title)
    set((s) => ({ byId: { ...s.byId, [id]: t } }))
  },

  async removeTab(id) {
    await api.remove(id)
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
    const tabs = await api.reorder(workspaceId, orderedIds)
    const byId: Record<string, Tab> = {}
    for (const t of tabs) byId[t.id] = t
    set({ byId, order: tabs.map((t) => t.id) })
  },

  async setActiveTab(id) {
    const workspaceId = get().workspaceId
    if (!workspaceId) return
    await api.setActive(workspaceId, id)
    set({ activeTabId: id })
  },

  async setLayout(layout) {
    const workspaceId = get().workspaceId
    if (!workspaceId) return
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
  },

  async assignToPane(id, slot) {
    // Evict whatever tab currently holds the target slot so a slot maps to one tab.
    if (slot !== null) {
      const occupant = selectTabList(get()).find((t) => t.paneSlot === slot && t.id !== id)
      if (occupant) {
        const cleared = await api.assignToPane(occupant.id, null)
        set((s) => ({ byId: { ...s.byId, [occupant.id]: cleared } }))
      }
    }
    const updated = await api.assignToPane(id, slot)
    set((s) => ({ byId: { ...s.byId, [id]: updated } }))
  }
}))
