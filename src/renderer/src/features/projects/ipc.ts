import type {
  Project,
  ProjectOverride,
  ProjectOverrideKind,
  ProjectPatch,
  RepoWorktrees,
  ProjectGitStatus,
  ProjectGitBranch,
  ProjectGitPreview,
  ProjectGitAction,
  ProjectGitCommitResult
} from '@common/domain'
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
export const listOverrides = (): Promise<ProjectOverride[]> => ipc().projects.listOverrides()
export const setOverride = (
  kind: ProjectOverrideKind,
  key: string,
  projectId: string | null
): Promise<void> => ipc().projects.setOverride(kind, key, projectId)
export const clearOverride = (kind: ProjectOverrideKind, key: string): Promise<void> =>
  ipc().projects.clearOverride(kind, key)
export const listWorktrees = (id: string): Promise<RepoWorktrees[]> =>
  ipc().projects.listWorktrees(id)
export const gitStatuses = (id: string): Promise<ProjectGitStatus[]> => ipc().projects.gitStatuses(id)
export const gitBranches = (id: string, path: string, discoverDefault = false): Promise<ProjectGitBranch[]> => ipc().projects.gitBranches(id, path, discoverDefault)
export const gitPreview = (id: string, path: string): Promise<ProjectGitPreview> => ipc().projects.gitPreview(id, path)
export const gitValidateName = (id: string, path: string, name: string): Promise<string | null> => ipc().projects.gitValidateName(id, path, name)
export const gitAction = (id: string, path: string, action: ProjectGitAction): Promise<string> => ipc().projects.gitAction(id, path, action)
export const gitCommit = (id: string, path: string, token: string, message: string, push: boolean): Promise<ProjectGitCommitResult> => ipc().projects.gitCommit(id, path, token, message, push)
