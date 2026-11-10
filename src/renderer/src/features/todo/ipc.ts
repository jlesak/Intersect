import type { TodoCreateInput, TodoLists, TodoQuery, TodoTask, TodoTaskPatch } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

export const list = (): Promise<TodoLists> => ipc().todo.list()
export const add = (input: TodoCreateInput | string, dueDay?: string | null): Promise<TodoTask> =>
  ipc().todo.add(input, dueDay)
export const update = (id: string, patch: TodoTaskPatch): Promise<TodoTask> =>
  ipc().todo.update(id, patch)
export const setDone = (id: string, done: boolean): Promise<TodoTask> =>
  ipc().todo.setDone(id, done)
export const complete = (id: string, revision: number) => ipc().todo.complete(id, revision)
export const getById = (id: string) => ipc().todo.getById(id)
export const history = (id: string) => ipc().todo.history(id)
export const query = (filter: TodoQuery, today: string) => ipc().todo.query(filter, today)
export const remove = (id: string): Promise<void> => ipc().todo.remove(id)
export const reorder = (orderedIds: string[], projectId?: string | null): Promise<TodoTask[]> =>
  ipc().todo.reorder(orderedIds, projectId)
export const listProjects = () => ipc().todo.listProjects()
export const createProject = (name: string) => ipc().todo.createProject(name)
export const updateProject = (id: string, name: string) => ipc().todo.updateProject(id, name)
export const removeProject = (id: string) => ipc().todo.removeProject(id)
export const listTags = () => ipc().todo.listTags()
export const createTag = (name: string) => ipc().todo.createTag(name)
export const updateTag = (id: string, name: string) => ipc().todo.updateTag(id, name)
export const removeTag = (id: string) => ipc().todo.removeTag(id)
export const listFilters = () => ipc().todo.listFilters()
export const createFilter = (name: string, filter: TodoQuery) => ipc().todo.createFilter(name, filter)
export const updateFilter = (id: string, name: string, filter: TodoQuery) =>
  ipc().todo.updateFilter(id, name, filter)
export const removeFilter = (id: string) => ipc().todo.removeFilter(id)
