import type { TodoReminderPermission } from '@common/ipc'
import type { Logger } from '@common/logging/logger'
import type { NativeReminders } from './native'

export const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.notifications'

export function createReminderPermissionHandlers(deps: {
  getNative(): NativeReminders | null
  openExternal(url: string): Promise<void>
  logger: Logger
}): {
  getReminderPermission(): Promise<TodoReminderPermission>
  openReminderSettings(): Promise<void>
} {
  return {
    async getReminderPermission() {
      const native = deps.getNative()
      if (!native) return 'unavailable'
      try {
        return await native.authorizationStatus()
      } catch (err) {
        deps.logger.warn('could not read todo reminder permission', { err })
        return 'error'
      }
    },
    openReminderSettings: () => deps.openExternal(NOTIFICATION_SETTINGS_URL)
  }
}
