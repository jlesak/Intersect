import type { NotificationSettings } from '@common/domain'
import type { SessionStatus } from '@common/ipc'

/**
 * Build the session notifier's `notify` callback from the user's persisted notification settings.
 *
 * The preferences are read fresh on every event through `getNotifications`, so a toggle changed in
 * the Settings section applies to the very next alert without restarting the app. An alert is
 * dropped when notifications are globally disabled or the specific status is toggled off, and the
 * `sound` preference is carried through to the raised notification so a muted session shows a
 * silent banner. `message`, when the notifier passed one along, is Claude's own notification text.
 */
export function createNotifyGate(
  getNotifications: () => NotificationSettings,
  raise: (sessionId: string, status: SessionStatus, sound: boolean, message?: string) => void
): (sessionId: string, status: SessionStatus, message?: string) => void {
  return (sessionId, status, message) => {
    const prefs = getNotifications()
    if (!prefs.enabled || !prefs[status]) return
    // Omit a trailing explicit `undefined` rather than always passing 4 args: `raise` (and tests
    // asserting its call args) should see exactly what a caller without a message passed - two.
    raise(sessionId, status, prefs.sound, ...(message === undefined ? [] : [message]))
  }
}
