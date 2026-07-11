import type { IpcMain } from 'electron'
import type { TodoPriority, TodoTaskPatch } from '@common/domain'
import { Channel, type IpcApi } from '@common/ipc'
import type { TodoRepo } from '../db/todoRepo'

export interface TodoHandlerDeps {
  todos: TodoRepo
}

/**
 * Re-throw any failure as a message-only Error. Only an Error's `.message` survives the IPC
 * boundary, so this normalizes non-Error throws into something the renderer can display.
 */
async function surface<T>(op: () => T | Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/**
 * TODO list handlers: thin delegation to the repo (the list has no service layer - it is pure
 * local state).
 */
export function createTodoHandlers(d: TodoHandlerDeps): IpcApi['todo'] {
  return {
    list: () => surface(() => ({ open: d.todos.listOpen(), done: d.todos.listDone() })),
    add: (text, dueDay, priority) => surface(() => d.todos.create(text, dueDay, priority)),
    update: (id, patch) => surface(() => d.todos.update(id, patch)),
    setDone: (id, done) => surface(() => d.todos.setDone(id, done)),
    remove: (id) => surface(() => d.todos.remove(id))
  }
}

export function registerTodoHandlers(ipcMain: IpcMain, h: IpcApi['todo']): void {
  ipcMain.handle(Channel.todoList, () => h.list())
  ipcMain.handle(
    Channel.todoAdd,
    (_e, text: string, dueDay: string | null, priority?: TodoPriority) => h.add(text, dueDay, priority)
  )
  ipcMain.handle(Channel.todoUpdate, (_e, id: string, patch: TodoTaskPatch) => h.update(id, patch))
  ipcMain.handle(Channel.todoSetDone, (_e, id: string, done: boolean) => h.setDone(id, done))
  ipcMain.handle(Channel.todoRemove, (_e, id: string) => h.remove(id))
}
