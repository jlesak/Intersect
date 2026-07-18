import { create } from 'zustand'
import type {
  AgentAdapter,
  AgentCatalogItem,
  AgentToolingScope,
  EffectiveConfig,
  SkillCatalogItem
} from '@common/domain'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

type Status = 'idle' | 'loading' | 'ready' | 'error'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Compare two scopes for equality so a redundant re-selection does not refetch. */
export function scopesEqual(a: AgentToolingScope, b: AgentToolingScope): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'global' || a.projectId === (b as { projectId: string }).projectId
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
  /** Switch scope and refetch; a no-op when the scope is unchanged. */
  setScope(scope: AgentToolingScope): void
  /** Fetch the effective config plus both catalogs for the current scope. */
  load(): Promise<void>
  /** Reveal a discovered source file in the OS file manager (failures toast, never throw). */
  reveal(path: string): Promise<void>
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

    setScope(scope) {
      if (scopesEqual(get().scope, scope)) return
      set({ scope, status: 'loading', error: null })
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
    }
  }
})
