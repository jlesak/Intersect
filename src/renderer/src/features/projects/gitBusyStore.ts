import { createStore } from '@renderer/shared/store/createStore'

interface BusyJob {
  id: number
  verb: string
}

interface GitBusyState {
  byRepo: Record<string, BusyJob>
  begin(commonDir: string, verb: string): number
  end(commonDir: string, id: number): void
}

let nextId = 0

/** The Git operation outlives a project view; all bindings share the canonical common directory. */
export const useGitBusyStore = createStore<GitBusyState>()((set, get) => ({
  byRepo: {},
  begin(commonDir, verb) {
    const id = ++nextId
    set((state) => ({ byRepo: { ...state.byRepo, [commonDir]: { id, verb } } }))
    return id
  },
  end(commonDir, id) {
    if (get().byRepo[commonDir]?.id !== id) return
    set((state) => {
      const byRepo = { ...state.byRepo }
      delete byRepo[commonDir]
      return { byRepo }
    })
  }
}))
