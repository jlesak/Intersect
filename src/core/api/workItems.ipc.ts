import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { WorkItemRef } from '@common/domain'
import type { JiraCacheRepo } from '../db/jiraCacheRepo'
import type { PrCacheRepo } from '../db/prCacheRepo'
import type { ProjectOverrideRepo } from '../db/projectOverrideRepo'
import type { ProjectRepo } from '../db/projectRepo'
import type { TodoRepo } from '../db/todoRepo'
import type { StoredWorkItemRef, WorkItemRefRepo } from '../db/workItemRefRepo'
import type { WorkspaceRepo } from '../db/workspaceRepo'
import { searchWorkItemCandidates } from '../workItems/searchCandidates'
import { computeWorkItemState, type WorkItemStateDeps } from '../workItems/workItemState'

export interface WorkItemsHandlerDeps {
  refs: WorkItemRefRepo
  workspaces: WorkspaceRepo
  projects: ProjectRepo
  overrides: ProjectOverrideRepo
  todos: TodoRepo
  prCache: PrCacheRepo
  jiraCache: JiraCacheRepo
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

/**
 * Primary work-item handlers. Refs are stored without their liveness; every read recomputes the
 * state against the current source caches, so a vanished remote item renders stale/missing
 * without any background writer touching the ref.
 */
export function createWorkItemsHandlers(d: WorkItemsHandlerDeps): IpcApi['workItems'] {
  const stateDeps: WorkItemStateDeps = {
    jiraIssuePresence: (issueKey) => d.jiraCache.issuePresence(issueKey),
    todoExists: (taskId) => d.todos.getById(taskId) !== undefined,
    prCached: (repositoryId, prId) => d.prCache.get(repositoryId, prId) !== undefined
  }

  const withState = (ref: StoredWorkItemRef): WorkItemRef => ({
    ...ref,
    state: computeWorkItemState(ref.source, ref.externalKey, stateDeps)
  })

  return {
    listForWorkspace: (workspaceId) =>
      surface(() => d.refs.listForWorkspace(workspaceId).map(withState)),

    setPrimary: (tabId, ref) => surface(() => withState(d.refs.set(tabId, ref))),

    clearPrimary: (tabId) => surface(() => d.refs.clear(tabId)),

    history: (tabId) => surface(() => d.refs.history(tabId)),

    searchCandidates: (query, workspaceId) =>
      surface(() => {
        // The workspace's projectId already encodes the canonical-cwd / repo-binding / worktree
        // resolution, so ranking by it IS the cwd-based preselection.
        const workspace = workspaceId !== null ? d.workspaces.getById(workspaceId) : undefined
        return searchWorkItemCandidates(query, workspace ? workspace.projectId : undefined, {
          jiraIssues: d.jiraCache.listAllIssues(),
          openTodos: d.todos.listOpen(),
          prs: d.prCache.list(),
          projects: d.projects.list(),
          overrides: d.overrides.list()
        })
      })
  }
}

export function workItemsWireRoutes(h: IpcApi['workItems']): WireRoutes {
  return {
    [Channel.workItemsListForWorkspace]: h.listForWorkspace,
    [Channel.workItemsSetPrimary]: h.setPrimary,
    [Channel.workItemsClearPrimary]: h.clearPrimary,
    [Channel.workItemsHistory]: h.history,
    [Channel.workItemsSearchCandidates]: h.searchCandidates
  }
}
