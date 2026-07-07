import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconTodo } from '@renderer/shared/ui/icons'
import { SidebarTodo } from './components/SidebarTodo'
import { TodoView } from './components/TodoView'

/** Registers the TODO sidebar section (owning the main area). It deliberately has no command. */
export function registerTodoFeature(): void {
  registerSidebarSection({
    id: 'todo',
    order: -0.5,
    label: 'TODO',
    icon: IconTodo,
    component: SidebarTodo,
    mainComponent: TodoView
  })
}
