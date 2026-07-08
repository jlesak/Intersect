import { create } from 'zustand'
import type { AdoSettings, NotificationSettings } from '@common/domain'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

/** The Test-connection button's lifecycle; success/error render inline next to it. */
export type AdoTestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'success'; displayName: string }
  | { status: 'error'; error: string }

interface SettingsState {
  status: Status
  error: string | null
  notifications: NotificationSettings
  ado: AdoSettings
  terminalFontSize: number
  adoTest: AdoTestState
  load(): Promise<void>
  /** Flip one notification toggle; persists immediately so nothing is ever lost. */
  setNotification(key: keyof NotificationSettings, value: boolean): Promise<void>
  /**
   * Update one ADO form field; persists immediately (per keystroke - a local SQLite upsert is
   * cheap) so switching categories or quitting never loses it. Any previous test-connection
   * outcome is stale once a field changes, so it resets.
   */
  setAdoField(key: keyof AdoSettings, value: string): Promise<void>
  /** Move the slider; live terminals restyle via the store subscription in settingsWiring. */
  setTerminalFontSize(px: number): Promise<void>
  /** Probe Azure DevOps with the current form values (saved or not) and record the outcome. */
  testConnection(): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Mirrors the main-process defaults so the UI is sensible before load() resolves. */
export const INITIAL_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  working: false,
  waiting: true,
  done: true,
  sound: true
}

const EMPTY_ADO: AdoSettings = { orgUrl: '', project: '', repository: '', pat: '' }

export const useSettingsStore = create<SettingsState>()((set, get) => {
  /** Persist a mutation the local state already reflects; a failure only toasts (no rollback -
      the next load() resyncs, and clobbering in-progress typing would be worse). */
  async function persist(op: () => Promise<unknown>, failure: string): Promise<void> {
    try {
      await op()
    } catch (e) {
      reportError(failure, e)
    }
  }

  return {
    status: 'idle',
    error: null,
    notifications: INITIAL_NOTIFICATIONS,
    ado: EMPTY_ADO,
    terminalFontSize: 12.5,
    adoTest: { status: 'idle' },

    async load() {
      if (get().status === 'idle') set({ status: 'loading', error: null })
      try {
        const settings = await api.get()
        set({
          status: 'ready',
          error: null,
          notifications: settings.notifications,
          ado: settings.ado,
          terminalFontSize: settings.appearance.terminalFontSize
        })
      } catch (e) {
        set({ status: 'error', error: message(e) })
      }
    },

    async setNotification(key, value) {
      const next = { ...get().notifications, [key]: value }
      set({ notifications: next })
      await persist(() => api.setNotifications(next), 'Could not save the notification settings')
    },

    async setAdoField(key, value) {
      const next = { ...get().ado, [key]: value }
      set({ ado: next, adoTest: { status: 'idle' } })
      await persist(() => api.setAdo(next), 'Could not save the Azure DevOps settings')
    },

    async setTerminalFontSize(px) {
      set({ terminalFontSize: px })
      await persist(() => api.setTerminalFontSize(px), 'Could not save the terminal font size')
    },

    async testConnection() {
      set({ adoTest: { status: 'testing' } })
      try {
        const result = await api.testAdoConnection(get().ado)
        set({
          adoTest: result.ok
            ? { status: 'success', displayName: result.displayName }
            : { status: 'error', error: result.error }
        })
      } catch (e) {
        set({ adoTest: { status: 'error', error: message(e) } })
      }
    }
  }
})
