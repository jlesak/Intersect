import type { BootState, Layout, NewWorkItemRef, Preset, Tab, Workspace } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// The tabs slice owns the selected workspace's terminal view, so it touches both the tabs
// channels and the workspace layout channel (layout persists on the workspace row).
export const listByWorkspace = (workspaceId: string): Promise<Tab[]> =>
  ipc().tabs.listByWorkspace(workspaceId)
// Fetched at hydrate time so the view always seeds from the workspace's freshest layout/activeTab.
export const workspaceState = (): Promise<BootState> => ipc().workspaces.getState()
// `paneSlot` is the group the tab is born into, which the caller resolves from where focus sits.
export const create = (
  workspaceId: string,
  preset: Preset,
  paneSlot: number,
  resumeSessionId?: string | null,
  primaryWorkItem?: NewWorkItemRef | null
): Promise<Tab> => ipc().tabs.create(workspaceId, preset, paneSlot, resumeSessionId, primaryWorkItem)
export const rename = (id: string, title: string): Promise<Tab> => ipc().tabs.rename(id, title)
export const remove = (id: string): Promise<void> => ipc().tabs.remove(id)
/**
 * Place a tab at `index` inside group `slot`. The group it left and the group it joined are both
 * renumbered in one transaction, so the answer is the workspace's whole tab list: the renderer
 * rebuilds from it rather than guessing which other rows shifted.
 */
export const moveTab = (id: string, slot: number, index: number): Promise<Tab[]> =>
  ipc().tabs.moveTab(id, slot, index)
/**
 * Focus a tab. The answer carries its new `lastActiveAt`, which is the stamp that decides which
 * tab its group shows, so the caller has to mirror the returned row rather than only the id.
 */
export const setActive = (workspaceId: string, tabId: string): Promise<Tab> =>
  ipc().tabs.setActive(workspaceId, tabId)
// Changing the layout regroups every tab, so the workspace comes back with the whole tab list.
export const setLayout = (
  workspaceId: string,
  layout: Layout
): Promise<{ workspace: Workspace; tabs: Tab[] }> => ipc().workspaces.setLayout(workspaceId, layout)
