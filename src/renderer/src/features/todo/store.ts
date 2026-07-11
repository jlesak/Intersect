import { create } from 'zustand'
import type { TodoPriority, TodoTask, TodoTaskPatch } from '@common/domain'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface TodoState {
  status: Status
  error: string | null
  /** Open tasks, ordered by priority then due date. */
  open: TodoTask[]
  /** Done tasks, most recently completed first. */
  done: TodoTask[]
  /** Whether the Done drawer is expanded. Renderer-only; every app start begins collapsed. */
  showDone: boolean
  load(): Promise<void>
  toggleShowDone(): void
  add(text: string, dueDay: string | null, priority?: TodoPriority): Promise<void>
  /** Edit any subset of a task's fields in place (inline editing). */
  update(id: string, patch: TodoTaskPatch): Promise<void>
  toggleDone(id: string, done: boolean): Promise<void>
  remove(id: string): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useTodoStore = create<TodoState>()((set, get) => {
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
      if (get().status === 'idle') set({ status: 'loading', error: null })
      await reload()
    },

    toggleShowDone() {
      set((s) => ({ showDone: !s.showDone }))
    },

    async add(text, dueDay, priority) {
      await mutate(() => api.add(text, dueDay, priority), 'Could not add the task')
    },

    async update(id, patch) {
      await mutate(() => api.update(id, patch), 'Could not save the task')
    },

    async toggleDone(id, done) {
      await mutate(() => api.setDone(id, done), 'Could not update the task')
    },

    async remove(id) {
      await mutate(() => api.remove(id), 'Could not delete the task')
    }
  }
})
