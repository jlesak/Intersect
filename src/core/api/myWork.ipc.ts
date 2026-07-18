import { type WireRoutes } from '@common/coreBridge'
import { GLOBAL_JIRA_SOURCE, projectJiraSource } from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import type { JiraLogin } from '../myWork/jiraLogin'
import type { JiraSyncEngine } from '../myWork/jiraSyncEngine'

export interface MyWorkHandlerDeps {
  engine: JiraSyncEngine
  login: JiraLogin
}

/**
 * Re-throw any failure as a message-only Error. Only an Error's `.message` survives the IPC
 * boundary, so this normalizes non-Error throws into something the renderer can display.
 */
async function surface<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/**
 * My Work handlers: thin delegation to the {@link JiraSyncEngine}, which owns the read-model
 * cache and the stale-while-revalidate refresh, plus the interactive SSO login. These are the
 * slice's only runtime entry points, and every one of them is a read or the login - there is no
 * Jira mutation or worklog operation to expose. A failed sync is not an exception here - it
 * travels inside the board envelope.
 */
export function createMyWorkHandlers(deps: MyWorkHandlerDeps): Omit<IpcApi['myWork'], 'onChanged'> {
  return {
    list: () => surface(() => deps.engine.getBoard(GLOBAL_JIRA_SOURCE)),
    refresh: () => surface(() => deps.engine.refresh(GLOBAL_JIRA_SOURCE)),
    login: () => surface(() => deps.login.login()),
    projectBoard: (projectId) => surface(() => deps.engine.getBoard(projectJiraSource(projectId))),
    refreshProject: (projectId) => surface(() => deps.engine.refresh(projectJiraSource(projectId)))
  }
}

export function myWorkWireRoutes(h: Omit<IpcApi['myWork'], 'onChanged'>): WireRoutes {
  return {
    [Channel.myWorkList]: h.list,
    [Channel.myWorkRefresh]: h.refresh,
    [Channel.myWorkLogin]: h.login,
    [Channel.myWorkProjectBoard]: h.projectBoard,
    [Channel.myWorkRefreshProject]: h.refreshProject
  }
}
