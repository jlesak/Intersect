import type { IpcMain } from 'electron'
import { Channel, type IpcApi } from '@common/ipc'
import type { JiraIndex } from '../myWork/jiraIndex'
import type { JiraLogin } from '../myWork/jiraLogin'

export interface MyWorkHandlerDeps {
  index: JiraIndex
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
 * My Work handlers: thin delegation to the in-memory {@link JiraIndex}. The index owns the caching
 * and the hidden fetch session; these handlers only bridge it to IPC and normalize errors. Note
 * that a failed board fetch is not an exception here - it travels as an `ok: false` result.
 */
export function createMyWorkHandlers(deps: MyWorkHandlerDeps): IpcApi['myWork'] {
  return {
    list: () => surface(() => deps.index.list()),
    refresh: () => surface(() => deps.index.refresh()),
    login: () => surface(() => deps.login.login())
  }
}

export function registerMyWorkHandlers(ipcMain: IpcMain, h: IpcApi['myWork']): void {
  ipcMain.handle(Channel.myWorkList, () => h.list())
  ipcMain.handle(Channel.myWorkRefresh, () => h.refresh())
  ipcMain.handle(Channel.myWorkLogin, () => h.login())
}
