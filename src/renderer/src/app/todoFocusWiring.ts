import { onReminderActivated, TODO_SECTION_ID, useTodoStore } from '@renderer/features/todo'
import { useShellStore } from './shellStore'

/**
 * Wire "take me to this task" to the shell. Any surface that knows a task id can ask for it without
 * knowing where the TODO list lives or whether it is even on screen; this app-layer coordinator
 * performs the one cross-slice step, the section switch.
 *
 * Unlike the other wiring modules the request is deliberately left standing rather than cleared
 * here: it *is* the payload, and the list that mounts as a result of the switch is what reads it and
 * clears it. Clearing first would navigate to the section and lose the row.
 *
 * Returns an unsubscribe so a test can wire a fresh copy without accumulating listeners.
 */
export function wireTodoFocus(): () => void {
  return useTodoStore.subscribe((state, prev) => {
    const id = state.pendingFocusId
    if (id === null || id === prev.pendingFocusId) return
    useShellStore.getState().setActiveSection(TODO_SECTION_ID)
  })
}

/**
 * Open the task whose macOS reminder the user clicked. Main sends the id only once this window has
 * loaded, and the focus request above does the rest: the section switch, the project or Inbox, and
 * the highlighted row, or "Task no longer exists." for a deleted task.
 *
 * Returns an unsubscribe so a test can wire a fresh copy without accumulating listeners.
 */
export function wireTodoReminderActivation(): () => void {
  return onReminderActivated(({ taskId }) => useTodoStore.getState().focusTask(taskId))
}
