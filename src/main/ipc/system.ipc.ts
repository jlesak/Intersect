import type { IpcMain } from 'electron'
import { Channel, type IpcApi } from '@common/ipc'
import { JIRA_HOST } from '../myWork/jiraMapping'

/** Hosts Intersect may hand to the system browser. Grows one entry per feature that links out. */
const ALLOWED_EXTERNAL_HOSTS = new Set([JIRA_HOST, 'notion.so', 'www.notion.so', 'slack.com'])

/**
 * Host suffixes allowed for services that address content by subdomain: Notion page links live
 * under user subdomains and a Slack channel link carries the workspace as its subdomain.
 */
const ALLOWED_EXTERNAL_HOST_SUFFIXES = ['.notion.so', '.slack.com']

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
  if (parsed.protocol !== 'https:') return false
  return (
    ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname) ||
    ALLOWED_EXTERNAL_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
  )
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

/** The system surface main implements (getPathForFile lives entirely in preload, off IPC). */
export type SystemHandlers = Omit<IpcApi['system'], 'getPathForFile'>

/** System-level handlers: the allowlist-guarded bridge to the default browser. */
export function createSystemHandlers(deps: SystemHandlerDeps): SystemHandlers {
  return {
    openExternal: (url) =>
      surface(async () => {
        if (!isAllowedExternalUrl(url)) throw new Error(`Blocked external URL: ${url}`)
        await deps.openExternal(url)
      })
  }
}

export function registerSystemHandlers(ipcMain: IpcMain, h: SystemHandlers): void {
  ipcMain.handle(Channel.systemOpenExternal, (_e, url: string) => h.openExternal(url))
}
