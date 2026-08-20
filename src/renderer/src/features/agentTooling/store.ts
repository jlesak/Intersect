import type {
  AgentAdapter,
  AgentCatalogItem,
  AgentToolingScope,
  ConfigEditRequest,
  ConfigPreview,
  ConfigSource,
  EffectiveConfig,
  SkillCatalogItem
} from '@common/domain'
import { createStore } from '@renderer/shared/store/createStore'
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

/**
 * A raw-editor buffer kept outside the component tree, so a hand-edited settings document survives
 * every unmount the shell performs: leaving Settings for another sidebar section, switching
 * category or sub-tab, closing the editor, a scope switch, the refresh after a save, and a render
 * crash caught by an error boundary. It lives in renderer memory for the session: closing the
 * window, quitting, reloading and restarting all drop it.
 */
export interface RawDraft {
  scope: AgentToolingScope
  source: ConfigSource
  /** The editor text as the user last left it. */
  content: string
  /** The on-disk bytes the edit was forked from, so a file that moved underneath is detectable. */
  baseline: string
  /** The revision guard `readRaw` answered for those bytes. */
  revision: string
  /** When the edit was last touched, so a stale-buffer notice can say how old it is. */
  updatedAt: number
}

/** The identity of one parked buffer: one raw editor per scope and target file. */
export function rawDraftKey(scope: AgentToolingScope, source: ConfigSource): string {
  const where = scope.kind === 'global' ? 'global' : `project:${scope.projectId}`
  return `${where}::${source}`
}

/** The buffer parked for one target file, or null when that file has no unsaved edit. */
export function selectRawDraft(
  state: { rawDrafts: Record<string, RawDraft> },
  scope: AgentToolingScope,
  source: ConfigSource
): RawDraft | null {
  return state.rawDrafts[rawDraftKey(scope, source)] ?? null
}

/**
 * The scope's most recently touched buffer, which is the file the pane reopens on. A scope can
 * hold one buffer per layered file; the last one edited is the one the user was working in.
 */
export function selectRawDraftForScope(
  state: { rawDrafts: Record<string, RawDraft> },
  scope: AgentToolingScope
): RawDraft | null {
  let best: RawDraft | null = null
  for (const draft of Object.values(state.rawDrafts)) {
    if (!scopesEqual(draft.scope, scope)) continue
    if (!best || draft.updatedAt >= best.updatedAt) best = draft
  }
  return best
}

/**
 * True while the browsed scope holds an unsaved raw edit, for the surfaces outside the raw panel
 * that have to point the user back at it.
 */
export function selectHasRawDraft(state: {
  scope: AgentToolingScope
  rawDrafts: Record<string, RawDraft>
}): boolean {
  return selectRawDraftForScope(state, state.scope) !== null
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
  /** Unsaved raw-editor buffers, one per scope and target file, keyed by `rawDraftKey`. */
  rawDrafts: Record<string, RawDraft>
  /** Switch scope and refetch; a no-op when the scope is unchanged. */
  setScope(scope: AgentToolingScope): void
  /**
   * Make the effective config plus both catalogs available for the current scope, reusing what is
   * already loaded. Every read walks the whole Claude Code configuration on disk, so a revisit to
   * a scope that is already in hand must cost nothing.
   */
  load(): Promise<void>
  /** Re-read the current scope from disk, for when its files are known to have changed. */
  refresh(): Promise<void>
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
  /** Keep an unsaved raw-editor buffer for its target file, replacing whatever that file held. */
  parkRawDraft(draft: RawDraft): void
  /** Drop one target file's parked buffer, for a save, a reload, or an explicit discard. */
  discardRawDraft(scope: AgentToolingScope, source: ConfigSource): void
}

export const useAgentToolingStore = createStore<AgentToolingState>()((set, get) => {
  // Answers can land out of order (a fast scope switch); only the latest load may set state.
  let requestSeq = 0
  // The scope the data in the store was read for, or null while nothing usable is held.
  let loadedScope: AgentToolingScope | null = null

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
    rawDrafts: {},

    setScope(scope) {
      if (scopesEqual(get().scope, scope)) return
      // A scope switch abandons any pending preview and undo bound to the old scope's files.
      set({ scope, status: 'loading', error: null, pendingPreview: null, lastUndo: null })
      void get().refresh()
    },

    async load() {
      const { status, scope } = get()
      if (status === 'ready' && loadedScope && scopesEqual(loadedScope, scope)) return
      await get().refresh()
    },

    async refresh() {
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
        loadedScope = scope
        set({ status: 'ready', error: null, config, skills, agents })
      } catch (e) {
        if (requestSeq !== seq) return
        loadedScope = null
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
        // The written text now is what is on disk, so the buffer it came from has nothing left to
        // protect. Leaving it parked would restore the pre-save text on the next open and read as
        // the save having been reverted. A buffer the user has typed past since the preview stays.
        const { scope, source, edit } = pending.request
        if (edit.kind === 'raw' && selectRawDraft(get(), scope, source)?.content === edit.content) {
          get().discardRawDraft(scope, source)
        }
        useToastStore
          .getState()
          .push(result.backupPath ? `Saved. Backup: ${result.backupPath}` : 'Saved.')
        await get().refresh()
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
        await get().refresh()
      } catch (e) {
        set({ saving: false })
        reportError('Undo failed', e)
      }
    },

    dismissUndo() {
      set({ lastUndo: null })
    },

    parkRawDraft(draft) {
      set({ rawDrafts: { ...get().rawDrafts, [rawDraftKey(draft.scope, draft.source)]: draft } })
    },

    discardRawDraft(scope, source) {
      const key = rawDraftKey(scope, source)
      if (!(key in get().rawDrafts)) return
      const rest = { ...get().rawDrafts }
      delete rest[key]
      set({ rawDrafts: rest })
    }
  }
})
