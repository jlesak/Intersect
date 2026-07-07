import { create } from 'zustand'
import type { NewManualTimeEntry, TimeEntry, TimeEntryUpdate } from '@common/domain'
import { addDays, weekStartOf } from '@common/week'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface TimeTrackingState {
  status: Status
  error: string | null
  /** The shown week's Monday day key (`yyyy-mm-dd`, local calendar). */
  weekStart: string
  /** The shown week's merged entries, in main's day-then-time order. */
  entries: TimeEntry[]
  /** First-open load of the current week (no-op unless idle). */
  hydrate(): Promise<void>
  loadWeek(weekStart: string): Promise<void>
  prevWeek(): Promise<void>
  nextWeek(): Promise<void>
  goToday(): Promise<void>
  /** Force a session re-scan from disk, then reload the shown week. */
  refresh(): Promise<void>
  addManual(input: NewManualTimeEntry): Promise<void>
  updateEntry(entry: TimeEntry, update: TimeEntryUpdate): Promise<void>
  removeEntry(entry: TimeEntry): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useTimeTrackingStore = create<TimeTrackingState>()((set, get) => {
  /** Reload the shown week; a response for a week no longer shown is dropped. */
  async function reload(): Promise<void> {
    const weekStart = get().weekStart
    try {
      const entries = await api.getWeek(weekStart)
      if (get().weekStart !== weekStart) return
      set({ status: 'ready', error: null, entries })
    } catch (e) {
      if (get().weekStart !== weekStart) return
      set({ status: 'error', error: message(e) })
    }
  }

  /** Run a mutation, then re-read the week so the board always shows main's truth. */
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
    weekStart: weekStartOf(Date.now()),
    entries: [],

    async hydrate() {
      if (get().status !== 'idle') return
      set({ status: 'loading', error: null })
      await reload()
    },

    async loadWeek(weekStart) {
      set({ weekStart, status: 'loading', error: null, entries: [] })
      await reload()
    },

    async prevWeek() {
      await get().loadWeek(addDays(get().weekStart, -7))
    },

    async nextWeek() {
      await get().loadWeek(addDays(get().weekStart, 7))
    },

    async goToday() {
      await get().loadWeek(weekStartOf(Date.now()))
    },

    async refresh() {
      const weekStart = get().weekStart
      set({ status: 'loading' })
      try {
        const entries = await api.refreshWeek(weekStart)
        if (get().weekStart !== weekStart) return
        set({ status: 'ready', error: null, entries })
      } catch (e) {
        if (get().weekStart !== weekStart) return
        set({ status: get().entries.length > 0 ? 'ready' : 'error', error: message(e) })
        reportError('Could not refresh time tracking', e)
      }
    },

    async addManual(input) {
      await mutate(() => api.addManual(input), 'Could not add the entry')
    },

    async updateEntry(entry, update) {
      await mutate(() => api.updateEntry(entry.source, entry.id, update), 'Could not save the change')
    },

    async removeEntry(entry) {
      await mutate(() => api.deleteEntry(entry.source, entry.id), 'Could not delete the entry')
    }
  }
})
