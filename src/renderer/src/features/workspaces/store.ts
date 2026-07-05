import { create } from 'zustand'
import type { Workspace } from '@common/domain'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface WorkspacesState {
  status: Status
  error: string | null
  byId: Record<string, Workspace>
  order: string[]
  selectedWorkspaceId: string | null
  hydrate(): Promise<void>
  create(folderPath: string, name?: string): Promise<Workspace | null>
  rename(id: string, name: string): Promise<void>
  remove(id: string): Promise<void>
  select(id: string): Promise<void>
  pickFolder(): Promise<string | null>
}

/** The workspaces in sidebar order. */
export function selectWorkspaceList(state: WorkspacesState): Workspace[] {
  return state.order.map((id) => state.byId[id]).filter(Boolean)
}

/** The currently selected workspace, or undefined. */
export function selectSelectedWorkspace(state: WorkspacesState): Workspace | undefined {
  return state.selectedWorkspaceId ? state.byId[state.selectedWorkspaceId] : undefined
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useWorkspacesStore = create<WorkspacesState>()((set) => ({
  status: 'idle',
  error: null,
  byId: {},
  order: [],
  selectedWorkspaceId: null,

  async hydrate() {
    set({ status: 'loading', error: null })
    try {
      const { workspaces, selectedWorkspaceId } = await api.getState()
      const byId: Record<string, Workspace> = {}
      for (const w of workspaces) byId[w.id] = w
      set({
        status: 'ready',
        byId,
        order: workspaces.map((w) => w.id),
        selectedWorkspaceId
      })
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  },

  async create(folderPath, name) {
    const ws = await api.create(folderPath, name)
    set((s) => ({
      byId: { ...s.byId, [ws.id]: ws },
      order: [...s.order, ws.id],
      selectedWorkspaceId: ws.id
    }))
    return ws
  },

  async rename(id, name) {
    const ws = await api.rename(id, name)
    set((s) => ({ byId: { ...s.byId, [id]: ws } }))
  },

  async remove(id) {
    await api.remove(id)
    set((s) => {
      const byId = { ...s.byId }
      delete byId[id]
      const order = s.order.filter((x) => x !== id)
      const selectedWorkspaceId =
        s.selectedWorkspaceId === id ? (order[0] ?? null) : s.selectedWorkspaceId
      return { byId, order, selectedWorkspaceId }
    })
  },

  async select(id) {
    await api.setActive(id)
    set({ selectedWorkspaceId: id })
  },

  async pickFolder() {
    return api.pickFolder()
  }
}))
