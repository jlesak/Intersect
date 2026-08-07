import { dayKeyOf } from '@common/week'
import { registerCapture } from '@renderer/shared/registries/captureRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconTodo } from '@renderer/shared/ui/icons'
import { useToastStore } from '@renderer/shared/ui/toast'
import { SidebarTodo } from './components/SidebarTodo'
import { TodoView } from './components/TodoView'
import { formatDueDay } from './due'
import { parseDueFromText } from './dueInput'
import { useTodoStore } from './store'

/** The rail id of the TODO section, so another surface can send the user to a task in it. */
export const TODO_SECTION_ID = 'todo'

/**
 * Registers the TODO sidebar section (owning the main area) and the `todo:` quick capture. The
 * section still has no palette command of its own - the rail is how you go to the list, and the
 * capture is for the far more common case of wanting to write something down without going there.
 */
export function registerTodoFeature(): void {
  registerSidebarSection({
    id: TODO_SECTION_ID,
    order: 11,
    label: 'TODO',
    icon: IconTodo,
    component: SidebarTodo,
    mainComponent: TodoView
  })
  registerCapture({
    prefix: 'todo:',
    hint: 'Add a task - "todo: call the vendor tomorrow"',
    preview(rest) {
      const today = dayKeyOf(Date.now())
      const { text, dueDay } = parseDueFromText(rest, today)
      if (text === '') return null
      return dueDay === null
        ? `Add task "${text}"`
        : `Add task "${text}", due ${formatDueDay(dueDay, today)}`
    },
    async run(rest) {
      const today = dayKeyOf(Date.now())
      const { text, dueDay } = parseDueFromText(rest, today)
      if (text === '') return
      await useTodoStore.getState().add(text, dueDay)
      // The TODO list is not on screen when a task is captured from elsewhere, so the confirmation
      // is the only thing telling the user it was written down - and which day it was pinned to.
      const when = dueDay === null ? '' : `, due ${formatDueDay(dueDay, today)}`
      useToastStore.getState().push(`Task added: ${text}${when}`)
    }
  })
}
