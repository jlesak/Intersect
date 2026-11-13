/**
 * The notification identifier of a task's macOS reminder. The core names reminders with it, main
 * reconciles only the pending requests that carry it, and a click maps it back to the task.
 */
const PREFIX = 'todo-reminder:'

export function reminderId(taskId: string): string {
  return `${PREFIX}${taskId}`
}

/** The task a notification identifier belongs to, or null when it is not a TODO reminder. */
export function taskIdFromReminderId(id: unknown): string | null {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return null
  const taskId = id.slice(PREFIX.length)
  return taskId === '' ? null : taskId
}
