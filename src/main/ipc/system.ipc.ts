import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import type { IpcMain } from 'electron'
import { Channel, type IpcApi } from '@common/ipc'
import { JIRA_HOST } from '../../core/myWork/jiraMapping'

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

/**
 * Whether a path may be revealed in the OS file manager: it must resolve (symlinks included) to
 * an existing regular file that lives under a `.claude` root - either `~/.claude` itself or any
 * ancestor directory named `.claude`. This is the belt-and-suspenders guard alongside the core's
 * own allowlist (the renderer only ever passes back a path the core already validated), so a
 * traversal or symlink escaping a `.claude` tree fails closed and is never handed to the shell.
 */
export function isRevealablePath(path: string): boolean {
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    return false
  }
  try {
    if (!statSync(real).isFile()) return false
  } catch {
    return false
  }
  let homeClaude: string | null
  try {
    homeClaude = realpathSync.native(join(homedir(), '.claude'))
  } catch {
    homeClaude = null
  }
  if (homeClaude && (real === homeClaude || real.startsWith(homeClaude + sep))) return true
  let dir = dirname(real)
  for (;;) {
    if (basename(dir) === '.claude') return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

export interface SystemHandlerDeps {
  /** The actual browser launch (Electron's shell.openExternal); injected for tests. */
  openExternal: (url: string) => Promise<void>
  /** Reveal a validated file in the OS file manager (Electron's shell.showItemInFolder). */
  revealInFolder: (path: string) => void
  /** The actual app relaunch (app.relaunch + app.exit); injected for tests. */
  restartApp: () => void
  /** Start a fresh core process after automatic recovery gave up (host.retry). */
  retryCore: () => void
  /** Quit through the coordinated shutdown path (app.quit); injected for tests. */
  quitApp: () => void
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
 * The system surface main implements (getPathForFile lives entirely in preload, off IPC;
 * onCoreStatus is a preload-side push subscription).
 */
export type SystemHandlers = Omit<IpcApi['system'], 'getPathForFile' | 'onCoreStatus'>

/** System-level handlers: the allowlist-guarded bridge to the default browser + recovery. */
export function createSystemHandlers(deps: SystemHandlerDeps): SystemHandlers {
  return {
    openExternal: (url) =>
      surface(async () => {
        if (!isAllowedExternalUrl(url)) throw new Error(`Blocked external URL: ${url}`)
        await deps.openExternal(url)
      }),
    revealPath: (path) =>
      surface(async () => {
        if (!isRevealablePath(path)) throw new Error(`Blocked reveal path: ${path}`)
        deps.revealInFolder(path)
      }),
    restartApp: () =>
      surface(async () => {
        deps.restartApp()
      }),
    retryCore: () =>
      surface(async () => {
        deps.retryCore()
      }),
    quitApp: () =>
      surface(async () => {
        deps.quitApp()
      })
  }
}

export function registerSystemHandlers(ipcMain: IpcMain, h: SystemHandlers): void {
  ipcMain.handle(Channel.systemOpenExternal, (_e, url: string) => h.openExternal(url))
  ipcMain.handle(Channel.systemRevealPath, (_e, path: string) => h.revealPath(path))
  ipcMain.handle(Channel.systemRestartApp, () => h.restartApp())
  ipcMain.handle(Channel.systemRetryCore, () => h.retryCore())
  ipcMain.handle(Channel.systemQuitApp, () => h.quitApp())
}
