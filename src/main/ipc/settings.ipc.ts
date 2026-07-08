import type { IpcMain } from 'electron'
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type AdoConnectionResult,
  type AdoSettings,
  type AppSettings,
  type NotificationSettings
} from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import type { SettingsRepo } from '../db/settingsRepo'

export interface SettingsHandlerDeps {
  settings: SettingsRepo
  /** The effective ADO config from `~/.claude.json`/env, shown until the user saves their own. */
  fallbackAdo(): AdoSettings
  testConnection(ado: AdoSettings): Promise<AdoConnectionResult>
  /**
   * Fired after ADO settings are persisted with a changed org URL, project, or PAT, so anything
   * holding a live connection built from the previous credentials (the long-lived ADO MCP client)
   * drops it and reconnects fresh. A repository-only change never fires it - the repository name
   * plays no part in the connection.
   */
  adoSettingsChanged(): Promise<void>
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
 * Settings handlers: every mutation persists immediately and answers with the full fresh
 * settings, so the renderer never has to compose partial state. Test-connection is a pure
 * probe of the given form values - it saves nothing.
 */
const EMPTY_ADO: AdoSettings = { orgUrl: '', project: '', repository: '', pat: '' }

export function createSettingsHandlers(d: SettingsHandlerDeps): IpcApi['settings'] {
  function current(): AppSettings {
    const fallback = d.fallbackAdo()
    return {
      notifications: d.settings.getNotifications(),
      // Only the values the user actually saved; a blank field defers live to the fallback (see
      // resolveAdoServerConfig), so nothing here freezes a copy of `~/.claude.json` / env.
      ado: d.settings.getSavedAdo() ?? EMPTY_ADO,
      adoFallback: {
        orgUrl: fallback.orgUrl,
        project: fallback.project,
        hasPat: fallback.pat.trim() !== ''
      },
      appearance: d.settings.getAppearance()
    }
  }

  /** Fill any blank form field from the live fallback, so a probe tests the effective connection. */
  function effectiveAdo(form: AdoSettings): AdoSettings {
    const fallback = d.fallbackAdo()
    return {
      orgUrl: form.orgUrl.trim() || fallback.orgUrl,
      project: form.project.trim() || fallback.project,
      repository: form.repository.trim() || fallback.repository,
      pat: form.pat.trim() || fallback.pat
    }
  }

  return {
    get: () => surface(() => current()),

    setNotifications: (notifications) =>
      surface(() => {
        d.settings.setNotifications(notifications)
        return current()
      }),

    setAdo: (ado) =>
      surface(async () => {
        const next: AdoSettings = {
          orgUrl: ado.orgUrl.trim(),
          project: ado.project.trim(),
          repository: ado.repository.trim(),
          pat: ado.pat.trim()
        }
        // The form persists on every keystroke, so most saves are no-ops or touch a single
        // field; only a genuine change writes, and only a connection-relevant one (anything
        // but the repository name) is worth dropping the live ADO client for.
        const prev = d.settings.getSavedAdo()
        if (
          prev &&
          prev.orgUrl === next.orgUrl &&
          prev.project === next.project &&
          prev.repository === next.repository &&
          prev.pat === next.pat
        ) {
          return current()
        }
        d.settings.setAdo(next)
        if (
          !prev ||
          prev.orgUrl !== next.orgUrl ||
          prev.project !== next.project ||
          prev.pat !== next.pat
        ) {
          await d.adoSettingsChanged()
        }
        return current()
      }),

    setTerminalFontSize: (px) =>
      surface(() => {
        if (typeof px !== 'number' || !Number.isFinite(px)) {
          throw new Error('Terminal font size must be a number')
        }
        d.settings.setAppearance({
          terminalFontSize: Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, px))
        })
        return current()
      }),

    testAdoConnection: (ado) => surface(() => d.testConnection(effectiveAdo(ado)))
  }
}

export function registerSettingsHandlers(ipcMain: IpcMain, h: IpcApi['settings']): void {
  ipcMain.handle(Channel.settingsGet, () => h.get())
  ipcMain.handle(Channel.settingsSetNotifications, (_e, notifications: NotificationSettings) =>
    h.setNotifications(notifications)
  )
  ipcMain.handle(Channel.settingsSetAdo, (_e, ado: AdoSettings) => h.setAdo(ado))
  ipcMain.handle(Channel.settingsSetTerminalFontSize, (_e, px: number) =>
    h.setTerminalFontSize(px)
  )
  ipcMain.handle(Channel.settingsTestAdoConnection, (_e, ado: AdoSettings) =>
    h.testAdoConnection(ado)
  )
}
