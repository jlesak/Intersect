import type { Project, ProjectPatch } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the projects store and the preload bridge.
export const list = (): Promise<Project[]> => ipc().projects.list()
export const create = (name: string, folderPath: string): Promise<Project> =>
  ipc().projects.create(name, folderPath)
export const update = (id: string, patch: ProjectPatch): Promise<Project> =>
  ipc().projects.update(id, patch)
export const setArchived = (id: string, archived: boolean): Promise<Project> =>
  ipc().projects.setArchived(id, archived)
export const reorder = (orderedIds: string[]): Promise<Project[]> =>
  ipc().projects.reorder(orderedIds)
export const remove = (id: string): Promise<void> => ipc().projects.remove(id)
export const addRepoPath = (id: string, folderPath: string): Promise<Project> =>
  ipc().projects.addRepoPath(id, folderPath)
export const removeRepoPath = (id: string, folderPath: string): Promise<Project> =>
  ipc().projects.removeRepoPath(id, folderPath)
/** The native folder picker is owned by the workspaces slice in main; reuse it verbatim. */
export const pickFolder = (): Promise<string | null> => ipc().workspaces.pickFolder()
