import type { TodoCreateInput, TodoProject, TodoQuery, TodoSavedFilter, TodoTag,
  TodoTask, TodoTaskPatch } from '@common/domain'
import { dayKeyOf } from '@common/week'
import { createStore } from '@renderer/shared/store/createStore'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'
export type TodoViewKey = 'today' | 'upcoming' | 'inbox' | 'project' | 'filter'

interface TodoState {
  status: Status
  error: string | null
  /** Open tasks in persisted manual order. */
  open: TodoTask[]
  /** Done tasks, most recently completed first. */
  done: TodoTask[]
  /** Whether the Done drawer is expanded. Renderer-only; every app start begins collapsed. */
  showDone: boolean
  /**
   * The task another surface asked to be taken to, until the list has revealed it. Left standing
   * across the section switch, because it is the only record of which row to reveal.
   */
  pendingFocusId: string | null
  focusResolvedId: string | null
  view: TodoViewKey
  activeProjectId: string | null
  activeFilterId: string | null
  projects: TodoProject[]
  tags: TodoTag[]
  filters: TodoSavedFilter[]
  /**
   * Whether projects, tags and filters have loaded successfully at least once. Until then an id
   * missing from them is unknown, never deleted. A later failed reload keeps the last lists.
   */
  planningReady: boolean
  queryTasks: TodoTask[]
  invalidFilter: boolean
  dayKey: string
  missingTask: boolean
  load(): Promise<void>
  loadPlanning(): Promise<void>
  setView(view: TodoViewKey, id?: string | null): void
  refreshView(day?: string): Promise<void>
  recheckDay(): Promise<void>
  createProject(name: string): Promise<void>
  updateProject(id: string, name: string): Promise<boolean>
  removeProject(id: string): Promise<void>
  createTag(name: string): Promise<void>
  updateTag(id: string, name: string): Promise<boolean>
  removeTag(id: string): Promise<void>
  createFilter(name: string, query: TodoQuery): Promise<boolean>
  updateFilter(id: string, name: string, query: TodoQuery): Promise<boolean>
  removeFilter(id: string): Promise<void>
  toggleShowDone(): void
  /**
   * Add a task, answering whether it was really written. A caller that confirms the add to the
   * user - quick capture, which never shows the list - has to be able to tell success from a
   * failure that only reported itself to a toast.
   */
  add(input: TodoCreateInput | string, dueDay?: string | null): Promise<boolean>
  /** Edit any subset of a task's fields in place (inline editing). */
  update(id: string, patch: TodoTaskPatch): Promise<boolean>
  toggleDone(id: string, done: boolean, displayedRevision?: number): Promise<void>
  remove(id: string): Promise<void>
  /** Apply the new order immediately, then persist it; failures resync from main. */
  reorder(orderedIds: string[]): Promise<void>
  /** Ask for a task to be brought into view and marked, from anywhere in the app. */
  focusTask(id: string): void
  /** The list has revealed the requested task; the request is spent. */
  clearFocus(): void
  resolveFocus(id: string): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useTodoStore = createStore<TodoState>()((set, get) => {
  let reorderRevision = 0
  let queryRevision = 0
  let focusRevision = 0
  let planningRevision = 0

  async function reload(): Promise<void> {
    try {
      const lists = await api.list()
      set({ status: 'ready', error: null, open: lists.open, done: lists.done })
      if (get().view === 'today' || get().view === 'filter') void get().refreshView()
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  }

  /**
   * Run a mutation, then re-read both lists so the section always shows main's truth. Answers
   * whether the mutation itself succeeded; a failure has already been reported to the user.
   * `applied` runs only after a success and before the re-read, for a known effect that has to
   * reach the screen in one step.
   */
  async function mutate(op: () => Promise<unknown>, failure: string,
    applied?: () => void): Promise<boolean> {
    reorderRevision += 1
    let ok = true
    try {
      await op()
    } catch (e) {
      ok = false
      reportError(failure, e)
    }
    if (ok) applied?.()
    await reload()
    return ok
  }

  return {
    status: 'idle',
    error: null,
    open: [],
    done: [],
    showDone: false,
    pendingFocusId: null,
    focusResolvedId: null,
    view: 'inbox',
    activeProjectId: null,
    activeFilterId: null,
    projects: [],
    tags: [],
    filters: [],
    planningReady: false,
    queryTasks: [],
    invalidFilter: false,
    dayKey: dayKeyOf(Date.now()),
    missingTask: false,

    focusTask(id) {
      set({ pendingFocusId: id, focusResolvedId: null, missingTask: false })
      void get().resolveFocus(id)
    },

    async resolveFocus(id) {
      const request = ++focusRevision
      try {
        const task = await api.getById(id)
        if (request !== focusRevision || get().pendingFocusId !== id) return
        if (!task) {
          set({ pendingFocusId: null, focusResolvedId: null, missingTask: true })
          return
        }
        set({ view: task.projectId ? 'project' : 'inbox',
          activeProjectId: task.projectId ?? null, activeFilterId: null,
          showDone: task.doneAt !== null, invalidFilter: false })
        await get().load()
        if (request === focusRevision && get().pendingFocusId === id)
          set({ focusResolvedId: id })
      } catch (e) {
        if (request === focusRevision) reportError('Could not find the task', e)
      }
    },

    clearFocus() {
      set({ pendingFocusId: null, focusResolvedId: null })
    },

    async load() {
      reorderRevision += 1
      if (get().status === 'idle') set({ status: 'loading', error: null })
      await reload()
    },

    async loadPlanning() {
      // An answer to an older request can predate a deletion, so only the newest one may land.
      const request = ++planningRevision
      try {
        const [projects, tags, filters] = await Promise.all([
          api.listProjects(), api.listTags(), api.listFilters()
        ])
        if (request === planningRevision) set({ projects, tags, filters, planningReady: true })
      } catch (e) {
        if (request === planningRevision) reportError('Could not load TODO planning', e)
      }
    },

    setView(view, id = null) {
      set({ view, activeProjectId: view === 'project' ? id : null,
        activeFilterId: view === 'filter' ? id : null, invalidFilter: false })
      void get().refreshView()
    },

    async refreshView(day = dayKeyOf(Date.now())) {
      const request = ++queryRevision
      const { view, activeFilterId, filters } = get()
      set({ dayKey: day })
      const query: TodoQuery | undefined = view === 'today'
        ? { version: 1, date: 'todayView' }
        : view === 'filter' ? filters.find((filter) => filter.id === activeFilterId)?.query : undefined
      if (!query) return
      try {
        const result = await api.query(query, day)
        if (request !== queryRevision || get().dayKey !== day || get().view !== view ||
          (view === 'filter' && get().activeFilterId !== activeFilterId)) return
        if (result.status === 'invalid') set({ queryTasks: [], invalidFilter: true })
        else set({ queryTasks: result.tasks, invalidFilter: false })
      } catch (e) { if (request === queryRevision) reportError('Could not load tasks', e) }
    },

    async recheckDay() {
      const day = dayKeyOf(Date.now())
      const { view, activeFilterId, filters, dayKey } = get()
      const filterDate = view === 'filter'
        ? filters.find((filter) => filter.id === activeFilterId)?.query.date : undefined
      if (view === 'today' || (day !== dayKey && filterDate && filterDate !== 'any'))
        await get().refreshView(day)
      else if (day !== dayKey) set({ dayKey: day })
    },

    async createProject(name) { await mutate(() => api.createProject(name), 'Could not create project'); await get().loadPlanning() },
    async updateProject(id, name) {
      const ok = await mutate(() => api.updateProject(id, name), 'Could not rename project')
      await get().loadPlanning()
      return ok
    },
    async removeProject(id) {
      // Main has moved the project's tasks to Inbox. Showing that and leaving the deleted project's
      // view in one update keeps an open task editor mounted: in two steps the task would first
      // drop out of the project list and its unsaved draft with it. The deletion is confirmed, so
      // it also holds if the reloads fail.
      const toInbox = (task: TodoTask): TodoTask =>
        task.projectId === id ? { ...task, projectId: null } : task
      await mutate(() => api.removeProject(id), 'Could not delete project', () => set((s) => ({
        projects: s.projects.filter((project) => project.id !== id),
        open: s.open.map(toInbox), done: s.done.map(toInbox), queryTasks: s.queryTasks.map(toInbox),
        ...(s.view === 'project' && s.activeProjectId === id
          ? { view: 'inbox' as const, activeProjectId: null } : {})
      })))
      await get().loadPlanning()
    },
    async createTag(name) { await mutate(() => api.createTag(name), 'Could not create tag'); await get().loadPlanning() },
    async updateTag(id, name) {
      const ok = await mutate(() => api.updateTag(id, name), 'Could not rename tag')
      await get().loadPlanning()
      return ok
    },
    async removeTag(id) {
      if (await mutate(() => api.removeTag(id), 'Could not delete tag'))
        set((s) => ({ tags: s.tags.filter((tag) => tag.id !== id) }))
      await get().loadPlanning()
    },
    async createFilter(name, query) {
      const ok = await mutate(() => api.createFilter(name, query), 'Could not save filter')
      await get().loadPlanning()
      return ok
    },
    async updateFilter(id, name, query) {
      const ok = await mutate(() => api.updateFilter(id, name, query), 'Could not save filter')
      await get().loadPlanning()
      await get().refreshView()
      return ok
    },
    async removeFilter(id) {
      if (await mutate(() => api.removeFilter(id), 'Could not delete filter')) {
        set((s) => ({ filters: s.filters.filter((filter) => filter.id !== id) }))
        if (get().activeFilterId === id) get().setView('inbox')
      }
      await get().loadPlanning()
    },

    toggleShowDone() {
      set((s) => ({ showDone: !s.showDone }))
    },

    async add(input, dueDay) {
      return mutate(() => typeof input === 'string' ? api.add(input, dueDay)
        : api.add(input), 'Could not add the task')
    },

    async update(id, patch) {
      return mutate(() => api.update(id, patch), 'Could not save the task')
    },

    async toggleDone(id, done, displayedRevision) {
      const task = [...get().open, ...get().done].find((item) => item.id === id)
      const expectedRevision = displayedRevision ?? task?.revision
      await mutate(() => done && expectedRevision !== undefined
        ? api.complete(id, expectedRevision) : api.setDone(id, done), 'Could not update the task')
    },

    async remove(id) {
      await mutate(() => api.remove(id), 'Could not delete the task')
    },

    async reorder(orderedIds) {
      const projectId = get().view === 'project' ? get().activeProjectId : null
      const open = get().open.filter((task) => (task.projectId ?? null) === projectId)
      const byId = new Map(open.map((task) => [task.id, task]))
      const exactOrder =
        orderedIds.length === open.length &&
        new Set(orderedIds).size === orderedIds.length &&
        orderedIds.every((id) => byId.has(id))
      if (!exactOrder) {
        reportError('Could not save the new order', new Error('Invalid local task order'))
        return
      }

      const revision = ++reorderRevision
      set({ open: [...get().open.filter((task) => (task.projectId ?? null) !== projectId),
        ...orderedIds.map((id, sortOrder) => ({ ...byId.get(id)!, sortOrder }))] })
      try {
        const canonical = projectId === null ? await api.reorder(orderedIds)
          : await api.reorder(orderedIds, projectId)
        if (revision === reorderRevision) set({ open: [...get().open.filter((task) =>
          (task.projectId ?? null) !== projectId), ...canonical], error: null })
      } catch (e) {
        reportError('Could not save the new order', e)
        if (revision === reorderRevision) await reload()
      }
    }
  }
})
