import type {
  NewManualTimeEntry,
  RunningTimer,
  TimeEntry,
  TimeEntryUpdate
} from '@common/domain'
import { addDays, weekStartOf } from '@common/week'
import { createStore } from '@renderer/shared/store/createStore'
import { reportError, useToastStore } from '@renderer/shared/ui/toast'
import * as api from './ipc'
import { loggedEntryNotice } from './time'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface TimeTrackingState {
  status: Status
  error: string | null
  /** The shown week's Monday day key (`yyyy-mm-dd`, local calendar). */
  weekStart: string
  /** The shown week's merged entries, in main's day-then-time order. */
  entries: TimeEntry[]
  /** The work timer currently running, or null. Elapsed time is derived from it, never stored. */
  timer: RunningTimer | null
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
  startTimer(description: string, issueKey: string | null): Promise<void>
  updateTimer(description: string, issueKey: string | null): Promise<void>
  /** Stop and log the span, then re-read the week so the new entry is on the board. */
  stopTimer(): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useTimeTrackingStore = createStore<TimeTrackingState>()((set, get) => {
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

  /** Read the running timer from the core. A failure leaves the last known value alone. */
  async function loadTimer(): Promise<void> {
    try {
      set({ timer: await api.getTimer() })
    } catch {
      // The board is still usable without the timer; a toast here would fire on every reload.
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
    timer: null,

    async hydrate() {
      if (get().status !== 'idle') return
      set({ status: 'loading', error: null })
      await reload()
      await loadTimer()
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
      await loadTimer()
    },

    async addManual(input) {
      await mutate(() => api.addManual(input), 'Could not add the entry')
    },

    async updateEntry(entry, update) {
      await mutate(() => api.updateEntry(entry.source, entry.id, update), 'Could not save the change')
    },

    async removeEntry(entry) {
      await mutate(() => api.deleteEntry(entry.source, entry.id), 'Could not delete the entry')
    },

    async startTimer(description, issueKey) {
      try {
        set({ timer: await api.startTimer(description, issueKey) })
      } catch (e) {
        reportError('Could not start the timer', e)
      }
    },

    async updateTimer(description, issueKey) {
      try {
        set({ timer: await api.updateTimer(description, issueKey) })
      } catch (e) {
        reportError('Could not change what the timer is tracking', e)
      }
    },

    async stopTimer() {
      let logged: TimeEntry | null
      try {
        logged = await api.stopTimer()
        set({ timer: null })
      } catch (e) {
        reportError('Could not stop the timer', e)
        // The core is the authority on whether it is still running, so ask rather than guess.
        await loadTimer()
        return
      }
      // A span the board cannot show is still a span that was recorded, and the user has to be
      // told where it went rather than left staring at an unchanged board.
      const notice = logged && loggedEntryNotice(logged)
      if (notice) useToastStore.getState().push(notice)
      await reload()
    }
  }
})
