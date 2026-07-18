import { type WireRoutes } from '@common/coreBridge'
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
    add: (text, dueDay) => surface(() => d.todos.create(text, dueDay)),
    update: (id, patch) => surface(() => d.todos.update(id, patch)),
    setDone: (id, done) => surface(() => d.todos.setDone(id, done)),
    remove: (id) => surface(() => d.todos.remove(id)),
    reorder: (orderedIds) => surface(() => d.todos.reorder(orderedIds))
  }
}

export function todoWireRoutes(h: IpcApi['todo']): WireRoutes {
  return {
    [Channel.todoList]: h.list,
    [Channel.todoAdd]: h.add,
    [Channel.todoUpdate]: h.update,
    [Channel.todoSetDone]: h.setDone,
    [Channel.todoRemove]: h.remove,
    [Channel.todoReorder]: h.reorder
  }
}
