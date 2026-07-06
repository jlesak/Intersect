import type { IpcMain } from 'electron'
import { Channel, type IpcApi } from '@common/ipc'
import { JIRA_HOST } from '../myWork/jiraMapping'

/** Hosts Intersect may hand to the system browser. Grows one entry per feature that links out. */
const ALLOWED_EXTERNAL_HOSTS = new Set([JIRA_HOST])

/**
 * Whether a URL may be opened in the system browser: https only, host allowlisted. Everything
 * else is rejected so this channel can never be used to launch arbitrary URLs or local schemes.
 */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)
}

export interface SystemHandlerDeps {
  /** The actual browser launch (Electron's shell.openExternal); injected for tests. */
  openExternal: (url: string) => Promise<void>
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

/** System-level handlers: the allowlist-guarded bridge to the default browser. */
export function createSystemHandlers(deps: SystemHandlerDeps): IpcApi['system'] {
  return {
    openExternal: (url) =>
      surface(async () => {
        if (!isAllowedExternalUrl(url)) throw new Error(`Blocked external URL: ${url}`)
        await deps.openExternal(url)
      })
  }
}

export function registerSystemHandlers(ipcMain: IpcMain, h: IpcApi['system']): void {
  ipcMain.handle(Channel.systemOpenExternal, (_e, url: string) => h.openExternal(url))
}
