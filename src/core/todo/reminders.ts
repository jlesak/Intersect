import type { TodoReminder } from '@common/coreBridge'
import type { TodoProject, TodoTask } from '@common/domain'
import type { Logger } from '@common/logging/logger'
import { reminderId } from '@common/todoReminder'

/**
 * How many reminders wait in macOS at once. The system keeps about 64 pending notifications per
 * app; the rest roll in from the hourly refresh while Intersect runs.
 */
export const REMINDER_LIMIT = 60

/**
 * The reminders that should be waiting in macOS now: one per open task with a due day and a due
 * time that is still ahead, soonest first and capped at REMINDER_LIMIT. A task has at most one
 * pending occurrence, so its id is the reminder's identity.
 */
export function planReminders(
  openTasks: readonly TodoTask[],
  projects: readonly TodoProject[],
  now: number
): TodoReminder[] {
  const projectName = new Map(projects.map((project) => [project.id, project.name]))
  const reminders: TodoReminder[] = []
  for (const task of openTasks) {
    if (task.doneAt !== null || !task.dueDay || !task.dueTime) continue
    const [year, month, day] = task.dueDay.split('-').map(Number)
    const [hour, minute] = task.dueTime.split(':').map(Number)
    const fireAt = new Date(year, month - 1, day, hour, minute).getTime()
    if (!(fireAt > now)) continue
    const where = (task.projectId && projectName.get(task.projectId)) || 'Inbox'
    reminders.push({
      id: reminderId(task.id),
      taskId: task.id,
      title: task.text,
      body: `Due ${task.dueTime} · ${where}`,
      fireAt,
      local: { year, month, day, hour, minute }
    })
  }
  reminders.sort((a, b) => a.fireAt - b.fireAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return reminders.slice(0, REMINDER_LIMIT)
}

export interface TodoReminderSyncDeps {
  listOpen(): TodoTask[]
  listProjects(): TodoProject[]
  now(): number
  /** Hands the full list to main. Fire-and-forget: a failure there must never fail a TODO call. */
  apply(reminders: TodoReminder[]): void
  logger: Logger
}

export interface TodoReminderSync {
  /** Recompute the full list and push it. Never throws. */
  refresh(): void
}

/**
 * Recomputes the whole reminder list on every call instead of tracking each operation: an edit, a
 * cleared time, a completion, a recurring completion that moves the due day, a rename or a project
 * change all reduce to "this is the list now".
 */
export function createTodoReminderSync(deps: TodoReminderSyncDeps): TodoReminderSync {
  return {
    refresh() {
      try {
        deps.apply(planReminders(deps.listOpen(), deps.listProjects(), deps.now()))
      } catch (err) {
        deps.logger.error('todo reminder refresh failed', { err })
      }
    }
  }
}
