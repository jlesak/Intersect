import type { TodoLists, TodoTask } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the todo store and the preload bridge.
export const list = (): Promise<TodoLists> => ipc().todo.list()
export const add = (text: string, dueDay: string | null): Promise<TodoTask> =>
  ipc().todo.add(text, dueDay)
export const setDone = (id: string, done: boolean): Promise<TodoTask> =>
  ipc().todo.setDone(id, done)
export const remove = (id: string): Promise<void> => ipc().todo.remove(id)
export const reorder = (orderedIds: string[]): Promise<TodoTask[]> =>
  ipc().todo.reorder(orderedIds)
