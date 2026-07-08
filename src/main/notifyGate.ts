import type { NotificationSettings } from '@common/domain'
import type { SessionStatus } from '@common/ipc'

/**
 * Build the session notifier's `notify` callback from the user's persisted notification settings.
 *
 * The preferences are read fresh on every event through `getNotifications`, so a toggle changed in
 * the Settings section applies to the very next alert without restarting the app. An alert is
 * dropped when notifications are globally disabled or the specific status is toggled off, and the
 * `sound` preference is carried through to the raised notification so a muted session shows a
 * silent banner.
 */
export function createNotifyGate(
  getNotifications: () => NotificationSettings,
  raise: (sessionId: string, status: SessionStatus, sound: boolean) => void
): (sessionId: string, status: SessionStatus) => void {
  return (sessionId, status) => {
    const prefs = getNotifications()
    if (!prefs.enabled || !prefs[status]) return
    raise(sessionId, status, prefs.sound)
  }
}
