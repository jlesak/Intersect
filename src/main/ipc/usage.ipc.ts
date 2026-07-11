import type { IpcMain } from 'electron'
import { Channel, type IpcApi } from '@common/ipc'
import type { UsageService } from '../usage/usageService'

/** The renderer-facing usage surface main implements (onUsageChanged is a preload-side push). */
export type UsageHandlers = Omit<IpcApi['usage'], 'onUsageChanged'>

export interface UsageHandlerDeps {
  usage: Pick<UsageService, 'get'>
}

/** Usage handlers: a single synchronous read of the last captured rate-limit snapshot. */
export function createUsageHandlers(d: UsageHandlerDeps): UsageHandlers {
  return {
    get: () => Promise.resolve(d.usage.get())
  }
}

export function registerUsageHandlers(ipcMain: IpcMain, h: UsageHandlers): void {
  ipcMain.handle(Channel.usageGet, () => h.get())
}
