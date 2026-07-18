import { create } from 'zustand'
import type { TodoTask, TodoTaskPatch } from '@common/domain'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface TodoState {
  status: Status
  error: string | null
  /** Open tasks in persisted manual order. */
  open: TodoTask[]
  /** Done tasks, most recently completed first. */
  done: TodoTask[]
  /** Whether the Done drawer is expanded. Renderer-only; every app start begins collapsed. */
  showDone: boolean
  load(): Promise<void>
  toggleShowDone(): void
  add(text: string, dueDay: string | null): Promise<void>
  /** Edit any subset of a task's fields in place (inline editing). */
  update(id: string, patch: TodoTaskPatch): Promise<void>
  toggleDone(id: string, done: boolean): Promise<void>
  remove(id: string): Promise<void>
  /** Apply the new order immediately, then persist it; failures resync from main. */
  reorder(orderedIds: string[]): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useTodoStore = create<TodoState>()((set, get) => {
  let reorderRevision = 0

  async function reload(): Promise<void> {
    try {
      const lists = await api.list()
      set({ status: 'ready', error: null, open: lists.open, done: lists.done })
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  }

  /** Run a mutation, then re-read both lists so the section always shows main's truth. */
  async function mutate(op: () => Promise<unknown>, failure: string): Promise<void> {
    reorderRevision += 1
    try {
      await op()
    } catch (e) {
      reportError(failure, e)
    }
    await reload()
  }

  return {
    status: 'idle',
    error: null,
    open: [],
    done: [],
    showDone: false,

    async load() {
      reorderRevision += 1
      if (get().status === 'idle') set({ status: 'loading', error: null })
      await reload()
    },

    toggleShowDone() {
      set((s) => ({ showDone: !s.showDone }))
    },

    async add(text, dueDay) {
      await mutate(() => api.add(text, dueDay), 'Could not add the task')
    },

    async update(id, patch) {
      await mutate(() => api.update(id, patch), 'Could not save the task')
    },

    async toggleDone(id, done) {
      await mutate(() => api.setDone(id, done), 'Could not update the task')
    },

    async remove(id) {
      await mutate(() => api.remove(id), 'Could not delete the task')
    },

    async reorder(orderedIds) {
      const open = get().open
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
      set({
        open: orderedIds.map((id, sortOrder) => ({ ...byId.get(id)!, sortOrder }))
      })
      try {
        const canonical = await api.reorder(orderedIds)
        if (revision === reorderRevision) set({ open: canonical, error: null })
      } catch (e) {
        reportError('Could not save the new order', e)
        if (revision === reorderRevision) await reload()
      }
    }
  }
})
