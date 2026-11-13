import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { TodoRepo } from '../db/todoRepo'

export interface TodoHandlerDeps {
  todos: TodoRepo
  /**
   * Called after every successful write that can change a reminder: a task's text, date, time or
   * state, or a project's name. Reordering and tags cannot, so they do not call it.
   */
  onChanged?: () => void
}

/** The request side of the TODO contract; the reminder click is a push from main. */
export type TodoHandlers = Omit<IpcApi['todo'], 'onReminderActivated'>

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
export function createTodoHandlers(d: TodoHandlerDeps): TodoHandlers {
  // A reminder failure must never fail the write the user just made, which is already committed.
  const changed = async <T>(op: () => T | Promise<T>): Promise<T> => {
    const result = await surface(op)
    try {
      d.onChanged?.()
    } catch {
      // The reminder sync logs its own failures.
    }
    return result
  }
  return {
    list: () => surface(() => ({ open: d.todos.listOpen(), done: d.todos.listDone() })),
    add: (input, dueDay) => changed(() => d.todos.create(input, dueDay)),
    update: (id, patch) => changed(() => d.todos.update(id, patch)),
    setDone: (id, done) => changed(() => d.todos.setDone(id, done)),
    remove: (id) => changed(() => d.todos.remove(id)),
    reorder: (orderedIds, projectId) => surface(() => d.todos.reorder(orderedIds, projectId)),
    getById: (id) => surface(() => d.todos.getById(id)),
    complete: (id, expectedRevision) => changed(() => d.todos.complete(id, expectedRevision)),
    history: (id) => surface(() => d.todos.history(id)),
    query: (query, today) => surface(() => d.todos.query(query, today)),
    listProjects: () => surface(() => d.todos.listProjects()),
    createProject: (name) => surface(() => d.todos.createProject(name)),
    updateProject: (id, name) => changed(() => d.todos.updateProject(id, name)),
    removeProject: (id) => changed(() => d.todos.removeProject(id)),
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

export function todoWireRoutes(h: TodoHandlers): WireRoutes {
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
