import type { TodoLists, TodoPriority, TodoTask, TodoTaskPatch } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the todo store and the preload bridge.
export const list = (): Promise<TodoLists> => ipc().todo.list()
export const add = (text: string, dueDay: string | null, priority?: TodoPriority): Promise<TodoTask> =>
  ipc().todo.add(text, dueDay, priority)
export const update = (id: string, patch: TodoTaskPatch): Promise<TodoTask> =>
  ipc().todo.update(id, patch)
export const setDone = (id: string, done: boolean): Promise<TodoTask> =>
  ipc().todo.setDone(id, done)
export const remove = (id: string): Promise<void> => ipc().todo.remove(id)
