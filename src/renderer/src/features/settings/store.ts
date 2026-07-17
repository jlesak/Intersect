import { create } from 'zustand'
import {
  DEFAULT_PR_REVIEW_PROMPT,
  type AdoFallback,
  type AdoSettings,
  type NotificationSettings,
  type ReviewSettings
} from '@common/domain'
import { debounce } from '@common/debounce'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

/** How long the font-size slider settles before its value is written to SQLite (see below). */
const FONT_SIZE_PERSIST_DELAY_MS = 250

type Status = 'idle' | 'loading' | 'ready' | 'error'

/** The Test-connection button's lifecycle; success/error render inline next to it. */
export type AdoTestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'success'; displayName: string }
  | { status: 'error'; error: string }

const EMPTY_ADO_FALLBACK: AdoFallback = { orgUrl: '', project: '', hasPat: false }

interface SettingsState {
  status: Status
  error: string | null
  notifications: NotificationSettings
  ado: AdoSettings
  /** Live fallback shown as form hints while a saved field is blank; never carries the PAT. */
  adoFallback: AdoFallback
  terminalFontSize: number
  review: ReviewSettings
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
  /**
   * Move the slider: the new size lands in state at once (live terminals restyle via the store
   * subscription in settingsWiring), while the SQLite write is debounced so a drag does not storm
   * the DB. `commitTerminalFontSize` flushes that pending write on pointer-up / relaunch.
   */
  setTerminalFontSize(px: number): void
  commitTerminalFontSize(): void
  /** Update locally and persist immediately so navigation or app quit cannot lose the edit. */
  setReviewPrompt(prompt: string): Promise<void>
  /** Restore and immediately persist the shared built-in prompt. */
  resetReviewPrompt(): Promise<void>
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

  /** The most recent slider value gets written once the drag settles; flushed on commit. */
  const persistFontSize = debounce((px: number) => {
    void persist(() => api.setTerminalFontSize(px), 'Could not save the terminal font size')
  }, FONT_SIZE_PERSIST_DELAY_MS)

  return {
    status: 'idle',
    error: null,
    notifications: INITIAL_NOTIFICATIONS,
    ado: EMPTY_ADO,
    adoFallback: EMPTY_ADO_FALLBACK,
    terminalFontSize: 12.5,
    review: { prompt: DEFAULT_PR_REVIEW_PROMPT },
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
          adoFallback: settings.adoFallback,
          terminalFontSize: settings.appearance.terminalFontSize,
          review: settings.review
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

    setTerminalFontSize(px) {
      set({ terminalFontSize: px })
      persistFontSize(px)
    },

    commitTerminalFontSize() {
      persistFontSize.flush()
    },

    async setReviewPrompt(prompt) {
      set({ review: { prompt } })
      await persist(() => api.setReview({ prompt }), 'Could not save the PR review prompt')
    },

    async resetReviewPrompt() {
      set({ review: { prompt: DEFAULT_PR_REVIEW_PROMPT } })
      await persist(
        () => api.setReview({ prompt: DEFAULT_PR_REVIEW_PROMPT }),
        'Could not reset the PR review prompt'
      )
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
