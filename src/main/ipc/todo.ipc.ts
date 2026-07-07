import type { IpcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { Channel, type IpcApi } from '@common/ipc'
import type { TodoRepo } from '../db/todoRepo'
import { tx } from '../db/tx'

export interface TodoHandlerDeps {
  db: DatabaseSync
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
 * local state). Reorder runs inside a transaction so a half-applied order can never persist.
 */
export function createTodoHandlers(d: TodoHandlerDeps): IpcApi['todo'] {
  return {
    list: () => surface(() => ({ open: d.todos.listOpen(), done: d.todos.listDone() })),
    add: (text, dueDay) => surface(() => d.todos.create(text, dueDay)),
    setDone: (id, done) => surface(() => d.todos.setDone(id, done)),
    remove: (id) => surface(() => d.todos.remove(id)),
    reorder: (orderedIds) => surface(() => tx(d.db, () => d.todos.reorder(orderedIds)))
  }
}

export function registerTodoHandlers(ipcMain: IpcMain, h: IpcApi['todo']): void {
  ipcMain.handle(Channel.todoList, () => h.list())
  ipcMain.handle(Channel.todoAdd, (_e, text: string, dueDay: string | null) => h.add(text, dueDay))
  ipcMain.handle(Channel.todoSetDone, (_e, id: string, done: boolean) => h.setDone(id, done))
  ipcMain.handle(Channel.todoRemove, (_e, id: string) => h.remove(id))
  ipcMain.handle(Channel.todoReorder, (_e, orderedIds: string[]) => h.reorder(orderedIds))
}
