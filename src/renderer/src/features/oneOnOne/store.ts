import { create } from 'zustand'
import type { OtoRun, OtoStartInput } from '@common/domain'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface OneOnOneState {
  status: Status
  error: string | null
  /** The full run history, newest first (main's ordering). */
  runs: OtoRun[]
  /** Whether the new-run form is open. Renderer-only; every app start begins closed. */
  showForm: boolean
  load(): Promise<void>
  setShowForm(show: boolean): void
  /**
   * Start a run: on success the new `running` run tops the history and the form closes. A
   * validation failure from main is re-thrown so the form can show it inline.
   */
  start(input: OtoStartInput): Promise<void>
  /** Listen for finished runs pushed from main; returns an unsubscribe fn. */
  subscribe(): () => void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Replace the run with the same id, or (for a run this window has not seen) prepend it. */
function upsertRun(runs: OtoRun[], run: OtoRun): OtoRun[] {
  return runs.some((r) => r.id === run.id)
    ? runs.map((r) => (r.id === run.id ? run : r))
    : [run, ...runs]
}

export const useOneOnOneStore = create<OneOnOneState>()((set, get) => ({
  status: 'idle',
  error: null,
  runs: [],
  showForm: false,

  async load() {
    if (get().status === 'idle') set({ status: 'loading', error: null })
    try {
      const runs = await api.list()
      // A run may finish between main building this snapshot and the renderer applying it, with
      // its runChanged push arriving first; a finished run already in the store must never be
      // regressed to the snapshot's still-running copy (no further push would come to fix it).
      set((s) => ({
        status: 'ready',
        error: null,
        runs: runs.map((run) => {
          const known = s.runs.find((r) => r.id === run.id)
          return known && known.finishedAt !== null && run.finishedAt === null ? known : run
        })
      }))
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  },

  setShowForm(show) {
    set({ showForm: show })
  },

  async start(input) {
    const run = await api.start(input)
    set((s) => ({ runs: upsertRun(s.runs, run), showForm: false }))
  },

  subscribe() {
    return api.onRunChanged((run) => set((s) => ({ runs: upsertRun(s.runs, run) })))
  }
}))
