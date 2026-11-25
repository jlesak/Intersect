import { resolve } from 'node:path'
import type {
  Project, RepoWorktrees, WorktreeDeleteRequest, WorktreeDeleteResult,
  WorktreeInfo, WorktreeSnapshot
} from '@common/domain'
import type { ProjectRepo } from '../db/projectRepo'
import { SELECTED_WORKSPACE_KEY, type AppStateRepo } from '../db/appStateRepo'
import type { TabRepo } from '../db/tabRepo'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import type { SessionManager } from '../pty/sessionManager'
import { git } from '../prInbox/git'
import { containsFolder, listProjectWorktrees } from './worktrees'

export interface WorktreeGuard {
  block(path: string, workspaceIds: string[]): void
  release(path: string, workspaceIds: string[]): void
  isFolderBlocked(path: string): boolean
  isWorkspaceBlocked(id: string): boolean
}

export function createWorktreeGuard(): WorktreeGuard {
  const folders = new Set<string>()
  const workspaces = new Set<string>()
  return {
    block(path, ids) { folders.add(path); ids.forEach((id) => workspaces.add(id)) },
    release(path, ids) { folders.delete(path); ids.forEach((id) => workspaces.delete(id)) },
    isFolderBlocked(path) { return [...folders].some((folder) => containsFolder(folder, path)) },
    isWorkspaceBlocked(id) { return workspaces.has(id) }
  }
}

export interface WorktreeServiceDeps {
  projects: ProjectRepo
  workspaces: WorkspaceRepo
  appState: AppStateRepo
  tabs: TabRepo
  sessions: SessionManager
  userDataDir: string
  onRepo: <T>(repoPath: string, job: () => Promise<T>) => Promise<T>
  guard: WorktreeGuard
}

export interface ProjectWorktreeService {
  list(projectId: string): Promise<RepoWorktrees[]>
  delete(request: WorktreeDeleteRequest): Promise<WorktreeDeleteResult>
  removeEntry(projectId: string, repoPath: string, path: string): Promise<void>
}

export function snapshotOf(wt: WorktreeInfo): WorktreeSnapshot {
  return {
    changed: wt.changed,
    lockedReason: wt.lockedReason,
    branch: wt.branch,
    head: wt.head,
    unpushed: wt.unpushed
  }
}

function sameSnapshot(a: WorktreeSnapshot, b: WorktreeSnapshot): boolean {
  return a.lockedReason === b.lockedReason &&
    a.branch === b.branch &&
    a.head === b.head &&
    a.unpushed === b.unpushed &&
    JSON.stringify(a.changed) === JSON.stringify(b.changed)
}

export function createProjectWorktreeService(d: WorktreeServiceDeps): ProjectWorktreeService {
  const projectFor = (id: string): Project => {
    const project = d.projects.getById(id)
    if (!project) throw new Error(`Project not found: ${id}`)
    return project
  }
  const bindingFor = (projectId: string, repoPath: string): Project => {
    const project = projectFor(projectId)
    if (!project.repoPaths.includes(repoPath)) throw new Error('Repository is not bound to this project')
    return project
  }
  const enrich = (wt: WorktreeInfo): WorktreeInfo => {
    const workspaces = d.workspaces.list()
      .filter((ws) => containsFolder(wt.path, ws.folderPath))
      .map((ws) => {
        const tabs = d.tabs.listByWorkspace(ws.id)
        return {
          id: ws.id,
          name: ws.name,
          tabs: tabs.length,
          runningClaude: tabs.filter((tab) =>
            tab.preset === 'claude' && d.sessions.isRunning(`${ws.id}:${tab.id}`)).length
        }
      })
    return { ...wt, workspaces }
  }
  const listBinding = async (project: Project, repoPath: string): Promise<WorktreeInfo[]> => {
    const result = (await listProjectWorktrees(
      { ...project, repoPaths: [repoPath] }, { userDataDir: d.userDataDir, enrich }
    ))[0]
    if (result.error) throw new Error(result.error)
    return result.worktrees
  }
  const target = async (
    project: Project, repoPath: string, path: string, missing: boolean
  ): Promise<WorktreeInfo> => {
    const entries = await listBinding(project, repoPath)
    const wt = entries.find((entry) => entry.path === path)
    if (!wt || wt.main || wt.bare || wt.managed || (wt.prunableReason !== null) !== missing) {
      throw new Error('Worktree is not an eligible linked worktree of this project')
    }
    // The exact path from Git is used for every destructive command. A forged alias cannot
    // turn a valid lookup into an operation on a different folder.
    if (resolve(wt.path) !== resolve(path)) throw new Error('Worktree path changed')
    return wt
  }
  const changed = (): WorktreeDeleteResult =>
    ({ outcome: 'changed', detail: 'Worktree changed. Refresh and review it before deleting.' })
  const removeWorkspaceRows = (wt: WorktreeInfo): { workspaceIds: string[]; closedTabs: number } => {
    const workspaceIds = wt.workspaces.map((ws) => ws.id)
    const closedTabs = wt.workspaces.reduce((n, ws) => n + ws.tabs, 0)
    for (const id of workspaceIds) d.workspaces.remove(id)
    if (workspaceIds.includes(d.appState.get(SELECTED_WORKSPACE_KEY) ?? '')) {
      d.appState.set(SELECTED_WORKSPACE_KEY, d.workspaces.list()[0]?.id ?? null)
    }
    return { workspaceIds, closedTabs }
  }
  return {
    async list(projectId) {
      return listProjectWorktrees(projectFor(projectId), {
        userDataDir: d.userDataDir, onRepo: d.onRepo, enrich
      })
    },
    async delete(request) {
      const project = bindingFor(request.projectId, request.repoPath)
      return d.onRepo(request.repoPath, async () => {
        const wt = await target(project, request.repoPath, request.path, false)
        if (!sameSnapshot(request.snapshot, snapshotOf(wt))) return changed()
        if (wt.changed.length > 0 && !request.discardChanges) return changed()
        if (wt.lockedReason !== null && !request.overrideLock) return changed()
        if (request.deleteBranch && !wt.branch) return changed()
        const ids = wt.workspaces.map((ws) => ws.id)
        d.guard.block(wt.path, ids)
        try {
          for (const id of ids) d.sessions.killWorkspace(id)
          const exits = await Promise.all(ids.map((id) => d.sessions.whenWorkspaceExited(id, 10_000)))
          if (exits.includes('timeout')) {
            return { outcome: 'timeout', detail: 'A session did not exit within 10 seconds. Nothing was deleted.' }
          }
          const fresh = await target(project, request.repoPath, request.path, false)
          if (!sameSnapshot(request.snapshot, snapshotOf(fresh))) return changed()
          const flags = fresh.lockedReason !== null
            ? ['--force', '--force']
            : fresh.changed.length > 0 ? ['--force'] : []
          await git(request.repoPath, ['worktree', 'remove', ...flags, fresh.path])
          const removed = removeWorkspaceRows(fresh)
          if (request.deleteBranch && fresh.branch) {
            try {
              await git(request.repoPath, ['branch', '-D', '--', fresh.branch])
            } catch (err) {
              return {
                outcome: 'partial',
                detail: err instanceof Error ? err.message : String(err),
                ...removed
              }
            }
          }
          return {
            outcome: 'deleted', branchDeleted: request.deleteBranch && Boolean(fresh.branch),
            ...removed
          }
        } finally {
          d.guard.release(wt.path, ids)
        }
      })
    },
    async removeEntry(projectId, repoPath, path) {
      const project = bindingFor(projectId, repoPath)
      await d.onRepo(repoPath, async () => {
        const wt = await target(project, repoPath, path, true)
        await git(repoPath, ['worktree', 'remove', wt.path])
      })
    }
  }
}
