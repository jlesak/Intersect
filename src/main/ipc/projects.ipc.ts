import type { IpcMain } from 'electron'
import type { ProjectPatch } from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import type { ProjectRepo } from '../db/projectRepo'
import type { ProjectPathDeps } from '../projects/resolveProject'
import { resolveProjectForPath } from '../projects/resolveProject'

export interface ProjectHandlerDeps {
  projects: ProjectRepo
  pathDeps: ProjectPathDeps
}

/**
 * Re-throw any failure as a message-only Error. Only an Error's `.message` survives the IPC
 * boundary, so this normalizes non-Error throws into something the renderer can display.
 */
async function surface<T>(op: () => T | Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/** Project handlers: thin delegation to the repo plus the pure path resolver. */
export function createProjectHandlers(d: ProjectHandlerDeps): IpcApi['projects'] {
  return {
    list: () => surface(() => d.projects.list()),
    create: (name, folderPath) => surface(() => d.projects.create(name, folderPath)),
    update: (id, patch) => surface(() => d.projects.update(id, patch)),
    setArchived: (id, archived) => surface(() => d.projects.setArchived(id, archived)),
    reorder: (orderedIds) => surface(() => d.projects.reorder(orderedIds)),
    remove: (id) => surface(() => d.projects.remove(id)),
    addRepoPath: (id, folderPath) => surface(() => d.projects.addRepoPath(id, folderPath)),
    removeRepoPath: (id, folderPath) => surface(() => d.projects.removeRepoPath(id, folderPath)),
    resolvePath: (path) =>
      surface(() => resolveProjectForPath(path, d.projects.list(), d.pathDeps))
  }
}

export function registerProjectHandlers(ipcMain: IpcMain, h: IpcApi['projects']): void {
  ipcMain.handle(Channel.projectsList, () => h.list())
  ipcMain.handle(Channel.projectsCreate, (_e, name: string, folderPath: string) =>
    h.create(name, folderPath)
  )
  ipcMain.handle(Channel.projectsUpdate, (_e, id: string, patch: ProjectPatch) =>
    h.update(id, patch)
  )
  ipcMain.handle(Channel.projectsSetArchived, (_e, id: string, archived: boolean) =>
    h.setArchived(id, archived)
  )
  ipcMain.handle(Channel.projectsReorder, (_e, orderedIds: string[]) => h.reorder(orderedIds))
  ipcMain.handle(Channel.projectsRemove, (_e, id: string) => h.remove(id))
  ipcMain.handle(Channel.projectsAddRepoPath, (_e, id: string, folderPath: string) =>
    h.addRepoPath(id, folderPath)
  )
  ipcMain.handle(Channel.projectsRemoveRepoPath, (_e, id: string, folderPath: string) =>
    h.removeRepoPath(id, folderPath)
  )
  ipcMain.handle(Channel.projectsResolvePath, (_e, path: string) => h.resolvePath(path))
}
