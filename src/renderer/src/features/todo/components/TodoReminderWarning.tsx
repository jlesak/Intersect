import { reportError } from '@renderer/shared/ui/toast'
import * as api from '../ipc'
import { useReminderPermission, useReminderPermissionStore } from '../reminderPermission'
import { useTodoStore } from '../store'

export function TodoReminderWarning(): React.JSX.Element | null {
  const hasTimedOpenTask = useTodoStore((s) => s.open.some((task) =>
    task.doneAt === null && Boolean(task.dueDay) && Boolean(task.dueTime)))
  const permission = useReminderPermissionStore((s) => s.permission)
  const dismissed = useReminderPermissionStore((s) => s.dismissed)
  useReminderPermission(hasTimedOpenTask)

  async function openSettings(): Promise<void> {
    try {
      await api.openReminderSettings()
    } catch (err) {
      reportError('Could not open notification settings. Open System Settings → Notifications → Intersect', err)
    }
  }

  if (!hasTimedOpenTask || permission !== 'denied' || dismissed) return null
  return <div className="ix-todo__reminder-warning" role="status">
    <span>TODO reminders are blocked by macOS. Allow notifications for Intersect in System Settings.</span>
    <div className="ix-todo__reminder-actions">
      <button type="button" className="ix-btn ix-btn--ghost" onClick={() => void openSettings()}>
        Open notification settings
      </button>
      <button type="button" className="ix-btn ix-btn--ghost"
        onClick={() => useReminderPermissionStore.setState({ dismissed: true })}>Dismiss</button>
    </div>
  </div>
}
