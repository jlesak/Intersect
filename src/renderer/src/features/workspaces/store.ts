import { create } from 'zustand'
import type { Workspace } from '@common/domain'
import { reportError } from '@renderer/shared/ui/toast'
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
  /** Manually place a workspace in a project (null = Other); persisted and wins over inference. */
  assignProject(id: string, projectId: string | null): Promise<void>
  /** Return a workspace to automatic assignment, re-resolving it from its folder path. */
  autoAssignProject(id: string): Promise<void>
}

/** The workspaces in sidebar order. */
export function selectWorkspaceList(state: WorkspacesState): Workspace[] {
  return state.order.map((id) => state.byId[id]).filter(Boolean)
}

/** The currently selected workspace, or undefined. */
export function selectSelectedWorkspace(state: WorkspacesState): Workspace | undefined {
  return state.selectedWorkspaceId ? state.byId[state.selectedWorkspaceId] : undefined
}

/** The workspaces of one project context (null = the virtual Other bucket), in sidebar order. */
export function workspacesForProject(state: WorkspacesState, projectId: string | null): Workspace[] {
  return selectWorkspaceList(state).filter((w) => w.projectId === projectId)
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
    try {
      const ws = await api.create(folderPath, name)
      set((s) => ({
        byId: { ...s.byId, [ws.id]: ws },
        order: [...s.order, ws.id],
        selectedWorkspaceId: ws.id
      }))
      return ws
    } catch (e) {
      reportError('Could not add the workspace', e)
      return null
    }
  },

  async rename(id, name) {
    try {
      const ws = await api.rename(id, name)
      set((s) => ({ byId: { ...s.byId, [id]: ws } }))
    } catch (e) {
      reportError('Could not rename the workspace', e)
    }
  },

  async remove(id) {
    try {
      await api.remove(id)
    } catch (e) {
      reportError('Could not delete the workspace', e)
      return
    }
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
    try {
      await api.setActive(id)
      set({ selectedWorkspaceId: id })
    } catch (e) {
      reportError('Could not switch workspace', e)
    }
  },

  async pickFolder() {
    try {
      return await api.pickFolder()
    } catch (e) {
      reportError('Could not open the folder picker', e)
      return null
    }
  },

  async assignProject(id, projectId) {
    try {
      const ws = await api.assignProject(id, projectId)
      set((s) => ({ byId: { ...s.byId, [id]: ws } }))
    } catch (e) {
      reportError('Could not move the workspace', e)
    }
  },

  async autoAssignProject(id) {
    try {
      const ws = await api.autoAssignProject(id)
      set((s) => ({ byId: { ...s.byId, [id]: ws } }))
    } catch (e) {
      reportError('Could not reset the workspace assignment', e)
    }
  }
}))
