import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TodoReminderLocalTime } from '@common/coreBridge'
import type { Logger } from '@common/logging/logger'
import type { PendingReminder } from './plan'

export type AuthorizationStatus = 'notDetermined' | 'denied' | 'authorized' | 'provisional' | 'unknown'

/** One request for the addon's `schedule`: a calendar trigger at `local`, default sound. */
export interface ReminderRequest {
  id: string
  title: string
  body: string
  local: TodoReminderLocalTime
}

/**
 * The surface of `native/todo-reminders` (UserNotifications). It never sets the notification
 * center's delegate: Electron owns it, and both session banners and reminder clicks need it.
 */
export interface NativeReminders {
  authorizationStatus(): Promise<AuthorizationStatus>
  /** Asks for alerts and sound. macOS prompts the user at most once. */
  requestAuthorization(): Promise<boolean>
  /** A request with the id of a pending one replaces it. */
  schedule(requests: ReminderRequest[]): Promise<void>
  /** Removes pending requests. Delivered ones stay in Notification Center. */
  cancel(ids: string[]): void
  pending(): Promise<PendingReminder[]>
}

const ADDON_FILE = 'todo_reminders.node'

/**
 * Where `build:native` puts the addon relative to the bundled main script. In the packaged app the
 * script lives inside `app.asar`, which a native library cannot be loaded from, so electron-builder
 * unpacks the addon to `app.asar.unpacked`.
 */
export function nativeAddonPath(mainDir: string): string {
  return join(mainDir, '..', 'native', ADDON_FILE).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

export interface LoadNativeRemindersOptions {
  /** The directory of the bundled main script (`__dirname`). */
  mainDir: string
  logger: Logger
  exists?: (path: string) => boolean
  dlopen?: (module: { exports: unknown }, filename: string) => void
}

/**
 * The only place that loads the addon. Returns null when it is missing or does not load, and the
 * app then runs without TODO reminders.
 */
export function loadNativeReminders(options: LoadNativeRemindersOptions): NativeReminders | null {
  const path = nativeAddonPath(options.mainDir)
  const exists = options.exists ?? existsSync
  const dlopen = options.dlopen ?? ((module, filename) => process.dlopen(module, filename))
  if (!exists(path)) {
    options.logger.warn('todo reminder addon is missing, reminders are off', { data: { path } })
    return null
  }
  try {
    const module: { exports: unknown } = { exports: {} }
    dlopen(module, path)
    return module.exports as NativeReminders
  } catch (err) {
    options.logger.warn('todo reminder addon did not load, reminders are off', {
      data: { path },
      err
    })
    return null
  }
}
