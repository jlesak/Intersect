import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconTodo } from '@renderer/shared/ui/icons'
import { SidebarTodo } from './components/SidebarTodo'
import { TodoView } from './components/TodoView'

/** The rail id of the TODO section, so another surface can send the user to a task in it. */
export const TODO_SECTION_ID = 'todo'

/** Registers the TODO sidebar section (owning the main area). It deliberately has no command. */
export function registerTodoFeature(): void {
  registerSidebarSection({
    id: TODO_SECTION_ID,
    order: 11,
    label: 'TODO',
    icon: IconTodo,
    component: SidebarTodo,
    mainComponent: TodoView
  })
}
