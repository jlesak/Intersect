import { create } from 'zustand'
import type { Project, ProjectOverride, ProjectOverrideKind, ProjectPatch } from '@common/domain'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface ProjectsState {
  status: Status
  error: string | null
  /** Every project (archived included), in manual order. */
  projects: Project[]
  /** Persisted manual assignments of external content (PRs, Jira issues) to projects. */
  overrides: ProjectOverride[]
  load(): Promise<void>
  /** Pick a folder and create a project bound to it; a null name defaults in the caller's UI. */
  create(name: string, folderPath: string): Promise<void>
  update(id: string, patch: ProjectPatch): Promise<void>
  setArchived(id: string, archived: boolean): Promise<void>
  remove(id: string): Promise<void>
  addRepoPath(id: string, folderPath: string): Promise<void>
  removeRepoPath(id: string, folderPath: string): Promise<void>
  /** Move a project one position up or down in the manual order. */
  move(id: string, direction: -1 | 1): Promise<void>
  /** Pin one external item to a project (null = Other); persists and wins over inference. */
  setOverride(kind: ProjectOverrideKind, key: string, projectId: string | null): Promise<void>
  /** Drop the item's manual pin so it falls back to binding-based inference. */
  clearOverride(kind: ProjectOverrideKind, key: string): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useProjectsStore = create<ProjectsState>()((set, get) => {
  async function reload(): Promise<void> {
    try {
      const [projects, overrides] = await Promise.all([api.list(), api.listOverrides()])
      set({ status: 'ready', error: null, projects, overrides })
    } catch (e) {
      set({ status: 'error', error: message(e) })
    }
  }

  /** Run a mutation, then re-read the list so the surface always shows main's truth. */
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
    projects: [],
    overrides: [],

    async load() {
      if (get().status === 'idle') set({ status: 'loading', error: null })
      await reload()
    },

    async create(name, folderPath) {
      await mutate(() => api.create(name, folderPath), 'Could not create the project')
    },

    async update(id, patch) {
      await mutate(() => api.update(id, patch), 'Could not save the project')
    },

    async setArchived(id, archived) {
      await mutate(() => api.setArchived(id, archived), 'Could not archive the project')
    },

    async remove(id) {
      await mutate(() => api.remove(id), 'Could not delete the project')
    },

    async addRepoPath(id, folderPath) {
      await mutate(() => api.addRepoPath(id, folderPath), 'Could not bind the folder')
    },

    async removeRepoPath(id, folderPath) {
      await mutate(() => api.removeRepoPath(id, folderPath), 'Could not unbind the folder')
    },

    async move(id, direction) {
      const ids = get().projects.map((p) => p.id)
      const from = ids.indexOf(id)
      const to = from + direction
      if (from === -1 || to < 0 || to >= ids.length) return
      ids.splice(from, 1)
      ids.splice(to, 0, id)
      await mutate(() => api.reorder(ids), 'Could not reorder projects')
    },

    async setOverride(kind, key, projectId) {
      await mutate(() => api.setOverride(kind, key, projectId), 'Could not assign to the project')
    },

    async clearOverride(kind, key) {
      await mutate(() => api.clearOverride(kind, key), 'Could not reset the assignment')
    }
  }
})

export const selectProjects = (s: ProjectsState): Project[] => s.projects

/** The projects shown as rail pins: unarchived, in manual order. */
export const selectActiveProjects = (s: ProjectsState): Project[] =>
  s.projects.filter((p) => !p.archived)
