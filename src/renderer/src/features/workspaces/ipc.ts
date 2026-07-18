import type { BootState, Layout, Workspace } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the workspaces store and the preload bridge.
export const getState = (): Promise<BootState> => ipc().workspaces.getState()
export const create = (folderPath: string, name?: string): Promise<Workspace> =>
  ipc().workspaces.create(folderPath, name)
export const rename = (id: string, name: string): Promise<Workspace> =>
  ipc().workspaces.rename(id, name)
export const remove = (id: string): Promise<void> => ipc().workspaces.remove(id)
export const setLayout = (id: string, layout: Layout): Promise<Workspace> =>
  ipc().workspaces.setLayout(id, layout)
export const setActive = (id: string): Promise<void> => ipc().workspaces.setActive(id)
export const pickFolder = (): Promise<string | null> => ipc().workspaces.pickFolder()
export const assignProject = (id: string, projectId: string | null): Promise<Workspace> =>
  ipc().workspaces.assignProject(id, projectId)
export const autoAssignProject = (id: string): Promise<Workspace> =>
  ipc().workspaces.autoAssignProject(id)
