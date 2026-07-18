import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { ProjectOverrideRepo } from '../db/projectOverrideRepo'
import type { ProjectRepo } from '../db/projectRepo'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import type { ProjectPathDeps } from '../projects/resolveProject'
import { resolveProjectForPath } from '../projects/resolveProject'
import { listProjectWorktrees } from '../projects/worktrees'

export interface ProjectHandlerDeps {
  projects: ProjectRepo
  pathDeps: ProjectPathDeps
  workspaces: WorkspaceRepo
  overrides: ProjectOverrideRepo
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
  /**
   * Re-resolve every automatically assigned workspace after a binding change (project created,
   * archived, removed, or a repo binding edited). Manually placed workspaces are never touched -
   * the override always wins until the user reverts it to automatic.
   */
  const reassignAutoWorkspaces = (): void => {
    const projects = d.projects.list()
    for (const ws of d.workspaces.list()) {
      if (ws.projectSource !== 'auto') continue
      const resolved = resolveProjectForPath(ws.folderPath, projects, d.pathDeps)
      if (resolved !== ws.projectId) d.workspaces.setProject(ws.id, resolved, 'auto')
    }
  }

  const withReassign = <T>(op: () => T): T => {
    const result = op()
    reassignAutoWorkspaces()
    return result
  }

  return {
    list: () => surface(() => d.projects.list()),
    create: (name, folderPath) => surface(() => withReassign(() => d.projects.create(name, folderPath))),
    update: (id, patch) => surface(() => d.projects.update(id, patch)),
    setArchived: (id, archived) =>
      surface(() => withReassign(() => d.projects.setArchived(id, archived))),
    reorder: (orderedIds) => surface(() => d.projects.reorder(orderedIds)),
    remove: (id) => surface(() => withReassign(() => d.projects.remove(id))),
    addRepoPath: (id, folderPath) =>
      surface(() => withReassign(() => d.projects.addRepoPath(id, folderPath))),
    removeRepoPath: (id, folderPath) =>
      surface(() => withReassign(() => d.projects.removeRepoPath(id, folderPath))),
    resolvePath: (path) =>
      surface(() => resolveProjectForPath(path, d.projects.list(), d.pathDeps)),
    listOverrides: () => surface(() => d.overrides.list()),
    setOverride: (kind, key, projectId) => surface(() => d.overrides.set(kind, key, projectId)),
    clearOverride: (kind, key) => surface(() => d.overrides.clear(kind, key)),
    listWorktrees: (id) =>
      surface(() => {
        const project = d.projects.getById(id)
        if (!project) throw new Error(`Project not found: ${id}`)
        return listProjectWorktrees(project)
      })
  }
}

export function projectsWireRoutes(h: IpcApi['projects']): WireRoutes {
  return {
    [Channel.projectsList]: h.list,
    [Channel.projectsCreate]: h.create,
    [Channel.projectsUpdate]: h.update,
    [Channel.projectsSetArchived]: h.setArchived,
    [Channel.projectsReorder]: h.reorder,
    [Channel.projectsRemove]: h.remove,
    [Channel.projectsAddRepoPath]: h.addRepoPath,
    [Channel.projectsRemoveRepoPath]: h.removeRepoPath,
    [Channel.projectsResolvePath]: h.resolvePath,
    [Channel.projectsListOverrides]: h.listOverrides,
    [Channel.projectsSetOverride]: h.setOverride,
    [Channel.projectsClearOverride]: h.clearOverride,
    [Channel.projectsListWorktrees]: h.listWorktrees
  }
}
