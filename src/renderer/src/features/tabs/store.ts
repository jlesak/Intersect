import type { Layout, NewWorkItemRef, Preset, Tab } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { visibleTabOf } from '@common/layout'
import { useAttentionStore } from '@renderer/features/attention'
import { disposeSession } from '@renderer/features/terminal'
import { createStore } from '@renderer/shared/store/createStore'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface TabsState {
  status: Status
  error: string | null
  workspaceId: string | null
  byId: Record<string, Tab>
  /**
   * Every tab of the workspace, always sorted by (paneSlot, sortOrder). One workspace-wide list
   * keeps the group selectors to a filter over a list that is already in bar order, and it is the
   * order the all-tabs overflow needs anyway.
   */
  order: string[]
  layout: Layout
  activeTabId: string | null
  /**
   * The preset the user reached for last, so the bare new-tab shortcut repeats their habit instead
   * of always opening a shell. Deliberately outlives switching workspace, but not the window: it is
   * never persisted, so every launch starts from the default again.
   */
  lastPreset: Preset
  /** Whether the "+" preset popover is showing, so the keyboard can open it as well as a click. */
  presetPickerOpen: boolean
  setPresetPickerOpen(open: boolean): void
  hydrate(workspaceId: string): Promise<void>
  clear(): void
  /** Open a tab at the end of the focused group and activate it there. */
  createTab(
    preset: Preset,
    resumeSessionId?: string | null,
    primaryWorkItem?: NewWorkItemRef | null
  ): Promise<Tab | null>
  renameTab(id: string, title: string): Promise<void>
  removeTab(id: string): Promise<void>
  /** Place a tab at `index` inside group `slot`, which covers both reordering and regrouping. */
  moveTab(id: string, slot: number, index: number): Promise<void>
  setActiveTab(id: string): Promise<void>
  /**
   * Activate the next tab of the focused group, wrapping past the last one back to the first.
   * Cycling stays inside the group the user is working in, the way VS Code cycles within an
   * editor group, so the split on screen never changes under the shortcut.
   */
  nextTab(): Promise<void>
  /**
   * Activate the tab at a 1-based position in the focused group's bar. The nine positional
   * accelerators are fixed while a group's tab count is not, so a position beyond the last tab
   * lands on the last tab rather than doing nothing.
   */
  jumpToTab(position: number): Promise<void>
  setLayout(layout: Layout): Promise<void>
  /**
   * Locally clear a tab's suspend marker once its session has been respawned, so the pane stops
   * showing the restored/resume state without waiting for a full re-hydrate. Mirrors the DB clear
   * the core performs via sessions.clearSuspended.
   */
  markResumed(id: string): void
}

/** Every tab of the workspace in bar order: group by group, and by position inside each group. */
export function selectTabList(state: TabsState): Tab[] {
  return state.order.map((id) => state.byId[id]).filter(Boolean)
}

/** One group's tabs in the order its own tab bar shows them. */
export function selectGroupTabs(state: TabsState, slot: number): Tab[] {
  return selectTabList(state).filter((tab) => tab.paneSlot === slot)
}

/**
 * The tab a group's pane is showing, or null while the group is empty. The result is a row out of
 * `byId`, so the selector is reference-stable and needs no useShallow at the call site.
 */
export function selectGroupVisibleTab(state: TabsState, slot: number): Tab | null {
  return visibleTabOf(selectGroupTabs(state, slot)) ?? null
}

/**
 * The group the user is working in: the active tab's. A workspace with nothing open still has to
 * point somewhere, and group 0 is the one group every layout has.
 */
export function selectFocusedSlot(state: TabsState): number {
  const active = state.activeTabId === null ? undefined : state.byId[state.activeTabId]
  return active?.paneSlot ?? 0
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Rebuilds `byId` and `order` from a tab list, enforcing the (paneSlot, sortOrder) invariant the
 * group selectors read. Main already answers in that order; sorting here means one place decides
 * what bar order is, whatever route the rows arrived by.
 */
function indexTabs(tabs: Tab[]): { byId: Record<string, Tab>; order: string[] } {
  const sorted = [...tabs].sort((a, b) => a.paneSlot - b.paneSlot || a.sortOrder - b.sortOrder)
  const byId: Record<string, Tab> = {}
  for (const tab of sorted) byId[tab.id] = tab
  return { byId, order: sorted.map((tab) => tab.id) }
}

const EMPTY = {
  status: 'idle' as Status,
  error: null,
  workspaceId: null,
  byId: {} as Record<string, Tab>,
  order: [] as string[],
  layout: 'single' as Layout,
  activeTabId: null as string | null,
  // Workspace-scoped: a popover left open over the old workspace's tab bar has no meaning in
  // the new one. `lastPreset` is deliberately absent - it is a user habit, not workspace data.
  presetPickerOpen: false
}

export const useTabsStore = createStore<TabsState>()((set, get) => ({
  ...EMPTY,
  lastPreset: 'shell',

  setPresetPickerOpen(open) {
    set({ presetPickerOpen: open })
  },

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
      set({
        status: 'ready',
        workspaceId,
        layout: ws.layout,
        activeTabId: ws.activeTabId,
        ...indexTabs(tabs)
      })
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  },

  clear() {
    set({ ...EMPTY })
  },

  async createTab(preset, resumeSessionId, primaryWorkItem) {
    const state = get()
    const workspaceId = state.workspaceId
    if (!workspaceId) return null
    // The new tab belongs where the user is looking, so the focused group decides its slot.
    const slot = selectFocusedSlot(state)
    let created: Tab
    try {
      created = await api.create(workspaceId, preset, slot, resumeSessionId, primaryWorkItem)
    } catch (e) {
      reportError('Could not open a terminal', e)
      return null
    }
    set((s) => ({ ...indexTabs([...selectTabList(s), created]), lastPreset: preset }))
    // A fresh tab carries no activation stamp, so its group would go on showing whatever it
    // showed before. Going through setActiveTab is the one path that both moves focus and writes
    // the stamp the visible-tab rule reads, so the pane switches to the terminal just opened.
    await get().setActiveTab(created.id)
    return created
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
    const before = get()
    const workspaceId = before.workspaceId
    const closing = before.byId[id]
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

    const remaining = selectTabList(before).filter((tab) => tab.id !== id)
    // Closing a tab the user was not on leaves focus exactly where it is.
    let successor = before.activeTabId
    if (before.activeTabId === id) {
      const siblings = closing
        ? remaining.filter((tab) => tab.paneSlot === closing.paneSlot)
        : remaining
      // Staying inside the group keeps the pane the user was working in on screen. Picking that
      // group's new visible tab means focus and what the pane shows cannot disagree. Only an
      // emptied group hands focus to another one, and then to the first tab of the first group.
      successor = (visibleTabOf(siblings) ?? remaining[0])?.id ?? null
    }
    set({ ...indexTabs(remaining), activeTabId: successor })

    // Main chooses its own successor when it deletes the row, and it cannot know about groups.
    // Persisting ours overrides that choice and stamps the tab we just made visible.
    if (successor !== null && before.activeTabId === id) await get().setActiveTab(successor)
  },

  async moveTab(id, slot, index) {
    try {
      // Both the source and the target group are renumbered by the move, so the canonical list
      // main answers with replaces the local one wholesale.
      const tabs = await api.moveTab(id, slot, index)
      set(indexTabs(tabs))
    } catch (e) {
      reportError('Could not move the tab', e)
    }
  },

  async setActiveTab(id) {
    const workspaceId = get().workspaceId
    if (!workspaceId) return
    try {
      const updated = await api.setActive(workspaceId, id)
      // Mirroring the returned lastActiveAt is what makes the group show the tab that was just
      // clicked; with only `activeTabId` moved, the pane would keep its previous terminal.
      set((s) => ({ byId: { ...s.byId, [updated.id]: updated }, activeTabId: id }))
    } catch (e) {
      reportError('Could not switch tabs', e)
    }
  },

  async nextTab() {
    const state = get()
    const group = selectGroupTabs(state, selectFocusedSlot(state))
    if (group.length < 2) return
    // No active tab means the cycle has not started yet, so it starts at the first tab.
    const current = group.findIndex((tab) => tab.id === state.activeTabId)
    await get().setActiveTab(group[(current + 1) % group.length].id)
  },

  async jumpToTab(position) {
    const state = get()
    const group = selectGroupTabs(state, selectFocusedSlot(state))
    if (group.length === 0) return
    const index = Math.min(Math.max(position, 1), group.length) - 1
    await get().setActiveTab(group[index].id)
  },

  async setLayout(layout) {
    const workspaceId = get().workspaceId
    if (!workspaceId) return
    try {
      // Shrinking the layout merges the groups that disappear, so main regroups every tab and
      // answers with the result. Rebuilding from that list is what keeps the two in step.
      const { workspace, tabs } = await api.setLayout(workspaceId, layout)
      set({ layout: workspace.layout, ...indexTabs(tabs) })
    } catch (e) {
      reportError('Could not change the layout', e)
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
