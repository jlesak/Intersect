import type { Layout, Preset, Tab, Workspace } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// The tabs slice owns the selected workspace's terminal view, so it touches both the tabs
// channels and the workspace layout channel (layout persists on the workspace row).
export const listByWorkspace = (workspaceId: string): Promise<Tab[]> =>
  ipc().tabs.listByWorkspace(workspaceId)
export const create = (workspaceId: string, preset: Preset): Promise<Tab> =>
  ipc().tabs.create(workspaceId, preset)
export const rename = (id: string, title: string): Promise<Tab> => ipc().tabs.rename(id, title)
export const remove = (id: string): Promise<void> => ipc().tabs.remove(id)
export const reorder = (workspaceId: string, orderedIds: string[]): Promise<Tab[]> =>
  ipc().tabs.reorder(workspaceId, orderedIds)
export const assignToPane = (id: string, slot: number | null): Promise<Tab> =>
  ipc().tabs.assignToPane(id, slot)
export const setActive = (workspaceId: string, tabId: string): Promise<void> =>
  ipc().tabs.setActive(workspaceId, tabId)
export const setLayout = (workspaceId: string, layout: Layout): Promise<Workspace> =>
  ipc().workspaces.setLayout(workspaceId, layout)
