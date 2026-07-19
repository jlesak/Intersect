import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_PR_REVIEW_PROMPT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type AdoSettings,
  type AppearanceSettings,
  type NotificationSettings,
  type ReviewSettings,
  type SessionSettings
} from '@common/domain'

// app_state keys the settings live under, one JSON document per category so saving one
// category can never clobber another.
const NOTIFICATIONS_KEY = 'settings.notifications'
const ADO_KEY = 'settings.ado'
const APPEARANCE_KEY = 'settings.appearance'
const REVIEW_KEY = 'settings.review'
const SESSION_KEY = 'settings.session'

/** The pre-settings behavior: waiting/done alert with sound, working stays quiet. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  working: false,
  waiting: true,
  done: true,
  sound: true
}

/** Matches XTERM_FONT_SIZE, the size every terminal used before it became configurable. */
export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  terminalFontSize: 12.5
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  prompt: DEFAULT_PR_REVIEW_PROMPT
}

/** The approved default: a confirmed quit resumes its suspended claude sessions automatically. */
export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  autoResume: true
}

/**
 * Typed user settings over the app_state key/value table. Reads merge the stored JSON over the
 * defaults, so a document written by an older app version (or a corrupted one) degrades to the
 * default for the missing/broken fields instead of failing.
 */
export interface SettingsRepo {
  getNotifications(): NotificationSettings
  setNotifications(notifications: NotificationSettings): void
  getAppearance(): AppearanceSettings
  setAppearance(appearance: AppearanceSettings): void
  getReview(): ReviewSettings
  setReview(review: ReviewSettings): void
  getSession(): SessionSettings
  setSession(session: SessionSettings): void
  /** The ADO settings saved from the UI, or null when the user never saved any. */
  getSavedAdo(): AdoSettings | null
  setAdo(ado: AdoSettings): void
}

export function createSettingsRepo(db: DatabaseSync): SettingsRepo {
  function read(key: string): Record<string, unknown> | null {
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined
    if (!row?.value) return null
    try {
      const parsed: unknown = JSON.parse(row.value)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  function write(key: string, value: object): void {
    db.prepare(
      'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, JSON.stringify(value))
  }

  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  return {
    getNotifications() {
      const raw = read(NOTIFICATIONS_KEY)
      const d = DEFAULT_NOTIFICATION_SETTINGS
      if (!raw) return { ...d }
      return {
        enabled: bool(raw.enabled, d.enabled),
        working: bool(raw.working, d.working),
        waiting: bool(raw.waiting, d.waiting),
        done: bool(raw.done, d.done),
        sound: bool(raw.sound, d.sound)
      }
    },

    setNotifications(notifications) {
      write(NOTIFICATIONS_KEY, notifications)
    },

    getAppearance() {
      const raw = read(APPEARANCE_KEY)
      const size = raw?.terminalFontSize
      if (typeof size !== 'number' || !Number.isFinite(size)) {
        return { ...DEFAULT_APPEARANCE_SETTINGS }
      }
      return {
        terminalFontSize: Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, size))
      }
    },

    setAppearance(appearance) {
      write(APPEARANCE_KEY, appearance)
    },

    getReview() {
      const prompt = read(REVIEW_KEY)?.prompt
      return { prompt: typeof prompt === 'string' ? prompt : DEFAULT_REVIEW_SETTINGS.prompt }
    },

    setReview(review) {
      write(REVIEW_KEY, review)
    },

    getSession() {
      const raw = read(SESSION_KEY)
      const d = DEFAULT_SESSION_SETTINGS
      if (!raw) return { ...d }
      return { autoResume: bool(raw.autoResume, d.autoResume) }
    },

    setSession(session) {
      write(SESSION_KEY, session)
    },

    getSavedAdo() {
      const raw = read(ADO_KEY)
      if (!raw) return null
      return {
        orgUrl: str(raw.orgUrl),
        project: str(raw.project),
        repository: str(raw.repository),
        pat: str(raw.pat)
      }
    },

    setAdo(ado) {
      write(ADO_KEY, ado)
    }
  }
}
