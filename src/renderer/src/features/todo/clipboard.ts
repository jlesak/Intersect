import type { TodoTask } from '@common/domain'
import { reportError } from '@renderer/shared/ui/toast'
import { formatDueDay } from './due'

/**
 * A task as plain text, for pasting into a message, a note or a work item.
 *
 * A bare task is one line, because that is what most tasks are and a paste should not arrive
 * padded with empty structure. Whatever else the task carries follows on its own line: the
 * description, then the due day in the same relative wording the row shows, so the paste reads
 * like the row it came from.
 */
export function todoClipboardText(task: TodoTask, today: string): string {
  const lines = [task.text]
  if (task.description !== '') lines.push(task.description)
  if (task.dueDay !== null) lines.push(`due ${formatDueDay(task.dueDay, today)}`)
  return lines.join('\n')
}

/**
 * Put a task on the clipboard. A refused or missing clipboard reports itself and leaves the task
 * alone, so a copy that did not happen is never mistaken for one that did.
 */
export async function copyTodoTask(task: TodoTask, today: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(todoClipboardText(task, today))
  } catch (e) {
    reportError('Could not copy the task', e)
  }
}
