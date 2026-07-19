import { create } from 'zustand'
import type {
  AgentAdapter,
  AgentCatalogItem,
  AgentToolingScope,
  ConfigEditRequest,
  ConfigPreview,
  EffectiveConfig,
  SkillCatalogItem
} from '@common/domain'
import { reportError, useToastStore } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Compare two scopes for equality so a redundant re-selection does not refetch. */
export function scopesEqual(a: AgentToolingScope, b: AgentToolingScope): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'global' || a.projectId === (b as { projectId: string }).projectId
}

/** A preview awaiting the user's confirmation, paired with the request that produced it. */
export interface PendingPreview {
  request: ConfigEditRequest
  preview: ConfigPreview
}

/** A just-committed save that can still be undone, and the backup it left behind. */
export interface LastUndo {
  path: string
  backupPath?: string
}

/** Human guidance per typed save-failure reason, so the toast tells the user what to do next. */
const SAVE_FAILURE_HINT: Record<string, string> = {
  'changed-externally': 'The file changed on disk. Reload and try again.',
  invalid: 'The proposed content is not valid.',
  blocked: 'That path is outside the allowed roots.',
  io: 'The write could not complete.'
}

interface AgentToolingState {
  adapter: AgentAdapter
  /** The browse scope, independent of the app shell context; defaults to global. */
  scope: AgentToolingScope
  status: Status
  error: string | null
  config: EffectiveConfig | null
  skills: SkillCatalogItem[]
  agents: AgentCatalogItem[]
  /** A preview open in the confirm dialog, or null when nothing is pending. */
  pendingPreview: PendingPreview | null
  /** True while a commit or undo write is in flight, so the dialog disables its actions. */
  saving: boolean
  /** The most recent successful save, offered a one-shot Undo until dismissed or superseded. */
  lastUndo: LastUndo | null
  /** Switch scope and refetch; a no-op when the scope is unchanged. */
  setScope(scope: AgentToolingScope): void
  /** Fetch the effective config plus both catalogs for the current scope. */
  load(): Promise<void>
  /** Reveal a discovered source file in the OS file manager (failures toast, never throw). */
  reveal(path: string): Promise<void>
  /** Preview a mutation and open the confirm dialog (even when invalid, so errors are visible). */
  preview(request: ConfigEditRequest): Promise<void>
  /** Discard the pending preview without writing. */
  cancelPreview(): void
  /** Commit the pending preview under its revision guard, then refresh the effective view. */
  commit(): Promise<void>
  /** Undo the last committed save, restoring the exact prior bytes, then refresh. */
  undo(): Promise<void>
  /** Dismiss the one-shot Undo affordance. */
  dismissUndo(): void
}

export const useAgentToolingStore = create<AgentToolingState>()((set, get) => {
  // Answers can land out of order (a fast scope switch); only the latest load may set state.
  let requestSeq = 0

  return {
    adapter: 'claude-code',
    scope: { kind: 'global' },
    status: 'idle',
    error: null,
    config: null,
    skills: [],
    agents: [],
    pendingPreview: null,
    saving: false,
    lastUndo: null,

    setScope(scope) {
      if (scopesEqual(get().scope, scope)) return
      // A scope switch abandons any pending preview and undo bound to the old scope's files.
      set({ scope, status: 'loading', error: null, pendingPreview: null, lastUndo: null })
      void get().load()
    },

    async load() {
      const seq = ++requestSeq
      const scope = get().scope
      if (get().status !== 'loading') set({ status: 'loading', error: null })
      try {
        const [config, skills, agents] = await Promise.all([
          api.getEffectiveConfig(scope),
          api.listSkills(scope),
          api.listAgents(scope)
        ])
        if (requestSeq !== seq) return
        set({ status: 'ready', error: null, config, skills, agents })
      } catch (e) {
        if (requestSeq !== seq) return
        set({ status: 'error', error: message(e), config: null, skills: [], agents: [] })
      }
    },

    async reveal(path) {
      try {
        await api.revealPath(path)
      } catch (e) {
        reportError('Could not open the source file', e)
      }
    },

    async preview(request) {
      try {
        const preview = await api.previewSave(request)
        set({ pendingPreview: { request, preview } })
      } catch (e) {
        reportError('Could not preview the change', e)
      }
    },

    cancelPreview() {
      set({ pendingPreview: null })
    },

    async commit() {
      const pending = get().pendingPreview
      if (!pending || !pending.preview.valid) return
      set({ saving: true })
      try {
        const result = await api.commitSave({
          ...pending.request,
          revision: pending.preview.revision
        })
        if (!result.ok) {
          const hint = result.reason ? SAVE_FAILURE_HINT[result.reason] : undefined
          useToastStore.getState().push(result.error ?? hint ?? 'The save was rejected')
          set({ saving: false, pendingPreview: null })
          return
        }
        set({
          saving: false,
          pendingPreview: null,
          lastUndo: { path: result.path, backupPath: result.backupPath }
        })
        useToastStore
          .getState()
          .push(result.backupPath ? `Saved. Backup: ${result.backupPath}` : 'Saved.')
        await get().load()
      } catch (e) {
        set({ saving: false, pendingPreview: null })
        reportError('The save failed', e)
      }
    },

    async undo() {
      const last = get().lastUndo
      if (!last) return
      set({ saving: true })
      try {
        const result = await api.undoSave(last.path)
        if (!result.ok) {
          useToastStore.getState().push(result.error ?? 'Undo was rejected')
          set({ saving: false })
          return
        }
        set({ saving: false, lastUndo: null })
        useToastStore.getState().push('Change undone.')
        await get().load()
      } catch (e) {
        set({ saving: false })
        reportError('Undo failed', e)
      }
    },

    dismissUndo() {
      set({ lastUndo: null })
    }
  }
})
