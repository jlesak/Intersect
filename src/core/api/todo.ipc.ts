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
    add: (input, dueDay) => surface(() => d.todos.create(input, dueDay)),
    update: (id, patch) => surface(() => d.todos.update(id, patch)),
    setDone: (id, done) => surface(() => d.todos.setDone(id, done)),
    remove: (id) => surface(() => d.todos.remove(id)),
    reorder: (orderedIds, projectId) => surface(() => d.todos.reorder(orderedIds, projectId)),
    getById: (id) => surface(() => d.todos.getById(id)),
    complete: (id, expectedRevision) => surface(() => d.todos.complete(id, expectedRevision)),
    history: (id) => surface(() => d.todos.history(id)),
    query: (query, today) => surface(() => d.todos.query(query, today)),
    listProjects: () => surface(() => d.todos.listProjects()),
    createProject: (name) => surface(() => d.todos.createProject(name)),
    updateProject: (id, name) => surface(() => d.todos.updateProject(id, name)),
    removeProject: (id) => surface(() => d.todos.removeProject(id)),
    listTags: () => surface(() => d.todos.listTags()),
    createTag: (name) => surface(() => d.todos.createTag(name)),
    updateTag: (id, name) => surface(() => d.todos.updateTag(id, name)),
    removeTag: (id) => surface(() => d.todos.removeTag(id)),
    listFilters: () => surface(() => d.todos.listFilters()),
    createFilter: (name, query) => surface(() => d.todos.createFilter(name, query)),
    updateFilter: (id, name, query) => surface(() => d.todos.updateFilter(id, name, query)),
    removeFilter: (id) => surface(() => d.todos.removeFilter(id))
  }
}

export function todoWireRoutes(h: IpcApi['todo']): WireRoutes {
  return {
    [Channel.todoList]: h.list,
    [Channel.todoAdd]: h.add,
    [Channel.todoUpdate]: h.update,
    [Channel.todoSetDone]: h.setDone,
    [Channel.todoRemove]: h.remove,
    [Channel.todoReorder]: h.reorder,
    [Channel.todoGetById]: h.getById,
    [Channel.todoComplete]: h.complete,
    [Channel.todoHistory]: h.history,
    [Channel.todoQuery]: h.query,
    [Channel.todoListProjects]: h.listProjects,
    [Channel.todoCreateProject]: h.createProject,
    [Channel.todoUpdateProject]: h.updateProject,
    [Channel.todoRemoveProject]: h.removeProject,
    [Channel.todoListTags]: h.listTags,
    [Channel.todoCreateTag]: h.createTag,
    [Channel.todoUpdateTag]: h.updateTag,
    [Channel.todoRemoveTag]: h.removeTag,
    [Channel.todoListFilters]: h.listFilters,
    [Channel.todoCreateFilter]: h.createFilter,
    [Channel.todoUpdateFilter]: h.updateFilter,
    [Channel.todoRemoveFilter]: h.removeFilter
  }
}
